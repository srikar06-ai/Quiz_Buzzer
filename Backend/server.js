const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// Production Security Hardening & Configurable CORS
const allowedOrigin = process.env.ALLOWED_ORIGIN || true;
app.use(cors({ origin: allowedOrigin }));
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self';");
    next();
});

// Serve static files from the Frontend directory
app.use(express.static(path.join(__dirname, '../Frontend')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: allowedOrigin,
    }
});

// Time sync for microsecond precision display
const startHrTime = process.hrtime.bigint();
const startDate = Date.now();

function getMicrosecondTime() {
    const currentHr = process.hrtime.bigint();
    const elapsedNano = currentHr - startHrTime;
    
    // Add IST Offset (UTC + 5:30)
    const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
    const currentTotalNano = (BigInt(startDate + istOffsetMs) * 1000000n) + elapsedNano;

    const date = new Date(Number(currentTotalNano / 1000000n));
    const h = String(date.getUTCHours()).padStart(2, '0');
    const m = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    
    const totalMicros = (currentTotalNano % 1000000000n) / 1000n;
    const millis = String(totalMicros / 1000n).padStart(3, '0');
    const micros = String(totalMicros % 1000n).padStart(3, '0');

    return `${h}:${m}:${s}:${millis}:${micros}`;
}

// App State Management
// rooms: { roomId: { host: socketId, groups: {}, buzzes: [], buzzedSockets: Set, buzzesAllowed: false, manualFreeze: false, disqualified: [], activeViolations: {}, pendingRequests: {} } }
const rooms = {};
const socketRoomMap = new Map(); // socket.id -> roomCode (O(1) disconnect lookup)
const socketRoleMap = new Map(); // socket.id -> 'host' | 'participant'

// Session Reconnection Engine (In-Memory, No DB / Redis)
const RECONNECT_GRACE_PERIOD_MS = parseInt(process.env.RECONNECT_GRACE_PERIOD_MS, 10) || 180000; // 3 minutes default grace period
const sessions = new Map(); // sessionToken -> { roomCode, role, groupName, socketId, points, cleanupTimer }
const socketSessionMap = new Map(); // socket.id -> sessionToken
const endedRoomWinners = new Map(); // roomCode -> { code, topScore, winners, hostSocketId }

// Per-Socket Rate Limiting System (In-Memory, No Redis)
const RATE_LIMIT_WINDOW_MS = 1000;
const MAX_EVENTS_PER_WINDOW = 15;
const socketRateLimits = new Map(); // socket.id -> { count, startTime }

function isRateLimited(socketId) {
    const now = Date.now();
    let limit = socketRateLimits.get(socketId);
    if (!limit || (now - limit.startTime > RATE_LIMIT_WINDOW_MS)) {
        limit = { count: 1, startTime: now };
        socketRateLimits.set(socketId, limit);
        return false;
    }
    limit.count++;
    return limit.count > MAX_EVENTS_PER_WINDOW;
}

function cleanSocketState(socketId) {
    socketRateLimits.delete(socketId);
    const roomCode = socketRoomMap.get(socketId);
    socketRoomMap.delete(socketId);
    socketRoleMap.delete(socketId);
    return roomCode;
}

// Cryptographically Strong 4-Letter Room Code Generator
function generateRoomCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 4; i++) {
        const randomIndex = crypto.randomInt(0, characters.length);
        result += characters.charAt(randomIndex);
    }
    return result;
}

// Input Validation Helpers
function isValidRoomCode(code) {
    return typeof code === 'string' && /^[A-Z]{4}$/.test(code.trim().toUpperCase());
}

function isValidName(name) {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    return trimmed.length > 0 && trimmed.length <= 30;
}

function isHost(socket, room) {
    return !!(room && room.host === socket.id);
}

// Socket.IO Real-Time Communication Engine
io.on('connection', (socket) => {

    // Host creates a room
    socket.on('create_room', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;

            let sessionToken = payload && typeof payload.sessionToken === 'string' ? payload.sessionToken.trim() : crypto.randomUUID();

            let code;
            let attempts = 0;
            do {
                code = generateRoomCode();
                attempts++;
            } while (rooms[code] && attempts < 100);

            if (rooms[code]) {
                socket.emit('error', 'Unable to generate room code. Please try again.');
                return;
            }

            rooms[code] = {
                host: socket.id,
                groups: {}, // socketId -> { name, points, lastHeartbeat, visibilityState, hasFocus }
                buzzes: [], // array of { socketId, name, timeStr }
                buzzedSockets: new Set(), // Set of socketIds for O(1) membership checking
                buzzesAllowed: false,
                manualFreeze: false,
                disqualified: [], // Array of disqualified names
                activeViolations: {}, // socketId -> violation details
                pendingRequests: {} // socketId -> name
            };

            socketRoomMap.set(socket.id, code);
            socketRoleMap.set(socket.id, 'host');
            socketSessionMap.set(socket.id, sessionToken);

            sessions.set(sessionToken, {
                roomCode: code,
                role: 'host',
                groupName: 'Host',
                socketId: socket.id,
                cleanupTimer: null
            });

            socket.join(code);
            socket.emit('room_created', { code, sessionToken });
        } catch (err) {
            console.error('Error in create_room:', err);
            socket.emit('error', 'Internal server error creating room.');
        }
    });

    // Session Resume Handler (Reconnection)
    socket.on('session_resume', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload.sessionToken !== 'string') {
                socket.emit('session_invalid');
                return;
            }

            const token = payload.sessionToken.trim();
            const session = sessions.get(token);
            if (!session) {
                socket.emit('session_expired', { message: 'Your quiz session has expired. Please rejoin the room.' });
                return;
            }

            const code = session.roomCode;
            const room = rooms[code];
            if (!room) {
                sessions.delete(token);
                socket.emit('session_expired', { message: 'Your quiz session has expired. Please rejoin the room.' });
                return;
            }

            // Cancel expiration timer if running
            if (session.cleanupTimer) {
                clearTimeout(session.cleanupTimer);
                session.cleanupTimer = null;
            }

            const oldSocketId = session.socketId;
            session.socketId = socket.id;
            socketSessionMap.set(socket.id, token);
            socketRoomMap.set(socket.id, code);
            socketRoleMap.set(socket.id, session.role);
            socket.join(code);

            if (session.role === 'host') {
                room.host = socket.id;
                socket.emit('session_restored', {
                    role: 'host',
                    code: code,
                    connectedTeams: Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })),
                    pendingRequests: Object.entries(room.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })),
                    disqualified: room.disqualified,
                    buzzes: room.buzzes,
                    buzzesAllowed: room.buzzesAllowed,
                    manualFreeze: room.manualFreeze
                });
            } else {
                // Participant session restore
                let group = room.groups[oldSocketId];
                if (group) {
                    delete room.groups[oldSocketId];
                    room.groups[socket.id] = group;
                } else if (!room.groups[socket.id]) {
                    room.groups[socket.id] = {
                        name: session.groupName,
                        points: session.points || 0,
                        lastHeartbeat: Date.now(),
                        visibilityState: 'visible',
                        hasFocus: true
                    };
                }
                group = room.groups[socket.id];
                group.lastHeartbeat = Date.now();
                group.disconnected = false;

                // Inform host participant has re-connected
                io.to(room.host).emit('group_connection_status', {
                    socketId: socket.id,
                    name: group.name,
                    connected: true
                });

                // Re-bind buzzes socketId if buzzed
                if (room.buzzedSockets.has(oldSocketId)) {
                    room.buzzedSockets.delete(oldSocketId);
                    room.buzzedSockets.add(socket.id);
                    room.buzzes.forEach(b => {
                        if (b.socketId === oldSocketId) b.socketId = socket.id;
                    });
                }

                // Re-bind activeViolations socketId
                if (room.activeViolations[oldSocketId]) {
                    const v = room.activeViolations[oldSocketId];
                    delete room.activeViolations[oldSocketId];
                    v.socketId = socket.id;
                    room.activeViolations[socket.id] = v;
                }

                // Re-bind pendingRequests
                if (room.pendingRequests[oldSocketId]) {
                    delete room.pendingRequests[oldSocketId];
                    room.pendingRequests[socket.id] = session.groupName;
                }

                const myBuzzIndex = room.buzzes.findIndex(b => b.socketId === socket.id);

                socket.emit('session_restored', {
                    role: 'participant',
                    code: code,
                    name: session.groupName,
                    points: group ? group.points : 0,
                    buzzesAllowed: room.buzzesAllowed,
                    buzzed: room.buzzedSockets.has(socket.id),
                    buzzRank: myBuzzIndex !== -1 ? myBuzzIndex + 1 : null,
                    isLocked: !!room.activeViolations[socket.id],
                    isDisqualified: room.disqualified.includes(session.groupName)
                });

                io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
            }
        } catch (err) {
            console.error('Error in session_resume:', err);
            socket.emit('session_invalid');
        }
    });

    // Group starts joining a room (request)
    socket.on('join_room', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload !== 'object') {
                socket.emit('error', 'Invalid payload.');
                return;
            }

            let { code, name, sessionToken } = payload;
            if (!isValidRoomCode(code) || !isValidName(name)) {
                socket.emit('error', 'Room code must be 4 letters and name must be 1-30 characters.');
                return;
            }

            code = code.trim().toUpperCase();
            name = name.trim();
            const token = typeof sessionToken === 'string' ? sessionToken.trim() : crypto.randomUUID();

            const room = rooms[code];
            if (!room) {
                socket.emit('error', 'Room not found.');
                return;
            }

            // Disqualification Check: Prevent disqualified teams from re-joining
            if (room.disqualified.includes(name)) {
                socket.emit('error', 'You have been disqualified from this room by the host.');
                return;
            }

            const existingNames = Object.values(room.groups).map(g => g.name);
            const pendingNames = Object.values(room.pendingRequests);
            if (existingNames.includes(name) || pendingNames.includes(name)) {
                socket.emit('error', 'Name already taken or pending approval.');
                return;
            }

            socketRoomMap.set(socket.id, code);
            socketRoleMap.set(socket.id, 'participant');
            socketSessionMap.set(socket.id, token);

            // Add to pending
            room.pendingRequests[socket.id] = name;

            // Freeze room for all clients while host reviews join request
            const allPendingNames = Object.values(room.pendingRequests);
            const violatorNames = Object.values(room.activeViolations).map(v => v.name || v);
            io.to(code).emit('global_freeze', {
                pendingNames: allPendingNames,
                violatorNames,
                manualFreeze: room.manualFreeze
            });

            // Target host-only events for privacy & performance
            io.to(room.host).emit('join_request', { socketId: socket.id, name });
            io.to(room.host).emit('requests_update', Object.entries(room.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })));
            socket.emit('waiting_for_approval', { sessionToken: token });
        } catch (err) {
            console.error('Error in join_room:', err);
            socket.emit('error', 'Internal server error joining room.');
        }
    });

    // Host resolves join request
    socket.on('resolve_join', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload !== 'object') return;

            let { code, targetSocketId, action } = payload;
            if (!isValidRoomCode(code) || typeof targetSocketId !== 'string' || typeof action !== 'string') return;
            code = code.trim().toUpperCase();

            const room = rooms[code];
            if (!isHost(socket, room)) {
                socket.emit('error', 'Unauthorized: Only room host can perform this action.');
                return;
            }

            const name = room.pendingRequests[targetSocketId];
            if (!name) return;

            if (action === 'allow') {
                room.groups[targetSocketId] = {
                    name,
                    points: 0,
                    lastHeartbeat: Date.now(),
                    visibilityState: 'visible',
                    hasFocus: true
                };

                const sessionToken = socketSessionMap.get(targetSocketId);
                if (sessionToken) {
                    sessions.set(sessionToken, {
                        roomCode: code,
                        role: 'participant',
                        groupName: name,
                        socketId: targetSocketId,
                        points: 0,
                        cleanupTimer: null
                    });
                }

                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (targetSocket) {
                    targetSocket.join(code);
                    targetSocket.emit('joined_room', { code, name, buzzesAllowed: room.buzzesAllowed });

                    // Notify host specifically
                    io.to(room.host).emit('group_joined', { socketId: targetSocketId, name, points: 0 });

                    // Broadcast updated points to room
                    io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
                }
            } else {
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (targetSocket) {
                    targetSocket.emit('error', 'Host rejected your join request.');
                }
            }

            delete room.pendingRequests[targetSocketId];
            delete room.activeViolations[targetSocketId];

            // Evaluate room freeze status
            const remainingPending = Object.values(room.pendingRequests);
            const remainingViolators = Object.values(room.activeViolations);
            const remainingViolatingNames = remainingViolators.map(v => v.name || v);

            if (remainingPending.length > 0 || remainingViolatingNames.length > 0 || room.manualFreeze) {
                io.to(code).emit('global_freeze', {
                    pendingNames: remainingPending,
                    violatorNames: remainingViolatingNames,
                    manualFreeze: room.manualFreeze
                });
                io.to(room.host).emit('tab_violation_alert', {
                    violations: remainingViolators
                });
            } else {
                io.to(code).emit('violation_resolved', { action: 'join_resolved', targetSocketId });
                io.to(room.host).emit('tab_violation_alert', { violations: [] });
            }

            io.to(room.host).emit('requests_update', Object.entries(room.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })));
        } catch (err) {
            console.error('Error in resolve_join:', err);
        }
    });

    // Group presses the buzzer (Ultra-low overhead critical path)
    socket.on('buzz', (rawCode) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!isValidRoomCode(rawCode)) return;
            const code = rawCode.trim().toUpperCase();
            const room = rooms[code];
            if (!room) return;

            // Check if buzzers are allowed
            if (!room.buzzesAllowed) return;

            // O(1) Set membership check for fast duplicate rejection
            if (room.buzzedSockets.has(socket.id)) return;

            const group = room.groups[socket.id];
            if (!group) return; // Not a registered group

            // Server-side active violation check
            if (room.activeViolations[socket.id]) {
                socket.emit('buzz_rejected', {
                    reason: 'VIOLATION_ACTIVE',
                    message: 'You have an active violation. Host must resolve your status before you can buzz.'
                });
                return;
            }

            // Disqualification protection
            if (room.disqualified.includes(group.name)) {
                socket.emit('buzz_rejected', {
                    reason: 'DISQUALIFIED',
                    message: 'You are disqualified from this room.'
                });
                return;
            }

            room.buzzedSockets.add(socket.id);
            const buzzData = {
                socketId: socket.id,
                name: group.name,
                timeStr: getMicrosecondTime()
            };

            room.buzzes.push(buzzData);

            // Acknowledge individual user buzz rank
            socket.emit('buzz_registered', { rank: room.buzzes.length });

            // Broadcast authoritative order to room
            io.to(code).emit('buzzes_update', room.buzzes);
        } catch (err) {
            console.error('Error in buzz:', err);
        }
    });

    // Host resets buzzers
    socket.on('reset_buzzers', (rawCode) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!isValidRoomCode(rawCode)) return;
            const code = rawCode.trim().toUpperCase();
            const room = rooms[code];

            if (!isHost(socket, room)) {
                socket.emit('error', 'Unauthorized: Only room host can perform this action.');
                return;
            }

            room.buzzes = [];
            room.buzzedSockets.clear();
            room.buzzesAllowed = false;

            io.to(code).emit('buzzes_update', room.buzzes);
            io.to(code).emit('buzzer_state', { active: false });
            io.to(code).emit('reset', { buzzesAllowed: false });
        } catch (err) {
            console.error('Error in reset_buzzers:', err);
        }
    });

    // Host toggles buzzers
    socket.on('toggle_buzzers', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload !== 'object') return;
            let { code, active } = payload;
            if (!isValidRoomCode(code) || typeof active !== 'boolean') return;
            code = code.trim().toUpperCase();
            const room = rooms[code];

            if (!isHost(socket, room)) {
                socket.emit('error', 'Unauthorized: Only room host can perform this action.');
                return;
            }

            room.buzzesAllowed = active;
            if (!active) {
                room.buzzes = [];
                room.buzzedSockets.clear();
                io.to(code).emit('buzzes_update', room.buzzes);
            }
            io.to(code).emit('buzzer_state', { active });
        } catch (err) {
            console.error('Error in toggle_buzzers:', err);
        }
    });

    // Host toggles manual freeze
    socket.on('toggle_manual_freeze', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload !== 'object') return;
            let { code, freeze } = payload;
            if (!isValidRoomCode(code) || typeof freeze !== 'boolean') return;
            code = code.trim().toUpperCase();
            const room = rooms[code];

            if (!isHost(socket, room)) {
                socket.emit('error', 'Unauthorized: Only room host can perform this action.');
                return;
            }

            room.manualFreeze = freeze;
            const pendingNames = Object.values(room.pendingRequests);
            const violatorNames = Object.values(room.activeViolations).map(v => v.name || v);

            if (freeze) {
                io.to(code).emit('global_freeze', {
                    pendingNames,
                    violatorNames,
                    manualFreeze: true
                });
            } else {
                if (pendingNames.length === 0 && violatorNames.length === 0) {
                    io.to(code).emit('violation_resolved', { action: 'manual_unfreeze' });
                } else {
                    io.to(code).emit('global_freeze', {
                        pendingNames,
                        violatorNames,
                        manualFreeze: false
                    });
                }
            }
            socket.emit('manual_freeze_status', { freeze });
        } catch (err) {
            console.error('Error in toggle_manual_freeze:', err);
        }
    });

    // Host updates points (strict integer check)
    socket.on('update_points', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload !== 'object') return;
            let { code, targetSocketId, delta } = payload;
            if (!isValidRoomCode(code) || typeof targetSocketId !== 'string') return;
            code = code.trim().toUpperCase();
            const room = rooms[code];

            if (!isHost(socket, room)) {
                socket.emit('error', 'Unauthorized: Only room host can perform this action.');
                return;
            }

            const deltaVal = Number(delta);
            if (!Number.isInteger(deltaVal) || Math.abs(deltaVal) > 1000) {
                socket.emit('error', 'Invalid point delta amount.');
                return;
            }

            if (room.groups[targetSocketId]) {
                room.groups[targetSocketId].points += deltaVal;
                io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
            }
        } catch (err) {
            console.error('Error in update_points:', err);
        }
    });

    // Participant Heartbeat Handler
    socket.on('participant_heartbeat', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload !== 'object') return;
            let { code, visibilityState, hasFocus } = payload;
            if (!isValidRoomCode(code)) return;
            code = code.trim().toUpperCase();
            const room = rooms[code];
            if (!room) return;

            const group = room.groups[socket.id];
            if (group) {
                group.lastHeartbeat = Date.now();
                group.visibilityState = typeof visibilityState === 'string' ? visibilityState : 'visible';
                group.hasFocus = typeof hasFocus === 'boolean' ? hasFocus : true;
            }
        } catch (err) {
            console.error('Error in participant_heartbeat:', err);
        }
    });

    // Participant Returned Handler
    socket.on('participant_returned', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload !== 'object') return;
            let { code } = payload;
            if (!isValidRoomCode(code)) return;
            code = code.trim().toUpperCase();
            const room = rooms[code];
            if (!room) return;

            const group = room.groups[socket.id];
            if (group) {
                if (room.activeViolations[socket.id]) {
                    room.activeViolations[socket.id].status = 'Returned to game (Waiting for Host)';
                }
                if (room.host) {
                    io.to(room.host).emit('participant_returned_alert', {
                        socketId: socket.id,
                        name: group.name,
                        timestamp: Date.now()
                    });
                    io.to(room.host).emit('tab_violation_alert', {
                        violations: Object.values(room.activeViolations)
                    });
                }
            }
        } catch (err) {
            console.error('Error in participant_returned:', err);
        }
    });

    // Participant Tab/Visibility Violation Handler
    socket.on('tab_violation', (data) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!data) return;
            let code = typeof data === 'string' ? data : data.code;
            if (!isValidRoomCode(code)) return;
            code = code.trim().toUpperCase();
            const room = rooms[code];
            if (!room) return;

            const group = room.groups[socket.id];
            const groupName = group ? group.name : room.pendingRequests[socket.id];
            if (groupName) {
                const type = typeof data === 'object' && typeof data.type === 'string' ? data.type : 'TAB_SWITCH';
                const date = new Date();
                const timeStr = date.toTimeString().split(' ')[0];

                room.activeViolations[socket.id] = {
                    socketId: socket.id,
                    name: groupName,
                    type: type,
                    timeStr: timeStr,
                    fullscreen: typeof data === 'object' ? !!data.fullscreen : false,
                    visibilityState: typeof data === 'object' && typeof data.visibilityState === 'string' ? data.visibilityState : 'hidden',
                    hasFocus: typeof data === 'object' && typeof data.hasFocus === 'boolean' ? data.hasFocus : false,
                    details: typeof data === 'object' && typeof data.details === 'string' ? data.details.slice(0, 100) : 'Participant switched focus or exited page',
                    status: 'Waiting for re-entry',
                    timestamp: Date.now()
                };

                const violatorNames = Object.values(room.activeViolations).map(v => v.name || v);
                const pendingNames = Object.values(room.pendingRequests);
                io.to(code).emit('global_freeze', {
                    violatorNames,
                    pendingNames,
                    manualFreeze: room.manualFreeze
                });

                // Host-only alert
                io.to(room.host).emit('tab_violation_alert', {
                    violations: Object.values(room.activeViolations)
                });
            }
        } catch (err) {
            console.error('Error in tab_violation:', err);
        }
    });

    // Host Resolves Violation
    socket.on('resolve_violation', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload !== 'object') return;
            let { code, targetSocketId, action } = payload;
            if (!isValidRoomCode(code) || typeof targetSocketId !== 'string' || typeof action !== 'string') return;
            code = code.trim().toUpperCase();
            const room = rooms[code];

            if (!isHost(socket, room)) {
                socket.emit('error', 'Unauthorized: Only room host can perform this action.');
                return;
            }

            if (action === 'disqualify') {
                const group = room.groups[targetSocketId];
                if (group) {
                    if (!room.disqualified.includes(group.name)) {
                        room.disqualified.push(group.name);
                    }
                    delete room.groups[targetSocketId];

                    room.buzzes = room.buzzes.filter(b => b.socketId !== targetSocketId);
                    room.buzzedSockets.delete(targetSocketId);

                    io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
                    io.to(code).emit('buzzes_update', room.buzzes);
                    io.to(room.host).emit('disqualified_update', room.disqualified);
                }
            }

            delete room.activeViolations[targetSocketId];

            const remainingViolators = Object.values(room.activeViolations);
            const remainingViolatorNames = remainingViolators.map(v => v.name || v);
            const remainingPendingNames = Object.values(room.pendingRequests);

            if (remainingViolatorNames.length > 0 || remainingPendingNames.length > 0 || room.manualFreeze) {
                io.to(code).emit('global_freeze', {
                    violatorNames: remainingViolatorNames,
                    pendingNames: remainingPendingNames,
                    manualFreeze: room.manualFreeze
                });

                if (remainingViolators.length > 0) {
                    io.to(room.host).emit('tab_violation_alert', {
                        violations: remainingViolators
                    });
                } else {
                    io.to(room.host).emit('tab_violation_alert', { violations: [] });
                }
            } else {
                io.to(code).emit('violation_resolved', { action, targetSocketId });
                io.to(room.host).emit('tab_violation_alert', { violations: [] });
            }

            io.to(targetSocketId).emit('individual_result', action);
        } catch (err) {
            console.error('Error in resolve_violation:', err);
        }
    });

    // Host ends quiz manually
    socket.on('room_closed_trigger', (rawCode) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!isValidRoomCode(rawCode)) return;
            const code = rawCode.trim().toUpperCase();
            const room = rooms[code];

            if (!isHost(socket, room)) {
                socket.emit('error', 'Unauthorized: Only room host can perform this action.');
                return;
            }

            // Calculate winner server-side from final scores
            let topScore = -Infinity;
            let winners = [];
            for (const sockId in room.groups) {
                const group = room.groups[sockId];
                if (group.points > topScore) {
                    topScore = group.points;
                    winners = [{ socketId: sockId, name: group.name, sessionToken: socketSessionMap.get(sockId) }];
                } else if (group.points === topScore) {
                    winners.push({ socketId: sockId, name: group.name, sessionToken: socketSessionMap.get(sockId) });
                }
            }

            const finalResults = {
                code: code,
                teams: Object.entries(room.groups).map(([id, g]) => ({ name: g.name, points: g.points })),
                disqualified: room.disqualified
            };

            if (winners.length > 0 && topScore > 0) {
                endedRoomWinners.set(code, {
                    code: code,
                    topScore: topScore,
                    winners: winners,
                    hostSocketId: socket.id
                });
                socket.emit('winner_detected', {
                    code: code,
                    winnerName: winners.map(w => w.name).join(', '),
                    topScore: topScore
                });
            }

            io.to(code).emit('room_closed', finalResults);
            // Clean up session mappings for this room
            for (const [token, sess] of sessions.entries()) {
                if (sess.roomCode === code) {
                    if (sess.cleanupTimer) clearTimeout(sess.cleanupTimer);
                    sessions.delete(token);
                }
            }
            delete rooms[code];
        } catch (err) {
            console.error('Error in room_closed_trigger:', err);
        }
    });

    // Host approves sending winner congratulations
    socket.on('approve_winner_message', (payload) => {
        try {
            if (isRateLimited(socket.id)) return;
            if (!payload || typeof payload !== 'object') return;
            let { code } = payload;
            if (!isValidRoomCode(code)) return;
            code = code.trim().toUpperCase();

            const winnerState = endedRoomWinners.get(code);
            if (!winnerState) return;

            if (winnerState.hostSocketId !== socket.id) {
                socket.emit('error', 'Unauthorized: Only room host can perform this action.');
                return;
            }

            winnerState.winners.forEach(w => {
                let targetSocketId = w.socketId;
                if (w.sessionToken && sessions.has(w.sessionToken)) {
                    targetSocketId = sessions.get(w.sessionToken).socketId;
                }
                const targetSock = io.sockets.sockets.get(targetSocketId);
                if (targetSock) {
                    targetSock.emit('winner_congratulations', {
                        winnerName: w.name,
                        points: winnerState.topScore
                    });
                }
            });

            endedRoomWinners.delete(code);
            socket.emit('winner_message_sent');
        } catch (err) {
            console.error('Error in approve_winner_message:', err);
        }
    });

    // Host declines sending winner congratulations
    socket.on('reject_winner_message', (payload) => {
        try {
            if (!payload || typeof payload !== 'object') return;
            let { code } = payload;
            if (!isValidRoomCode(code)) return;
            code = code.trim().toUpperCase();
            endedRoomWinners.delete(code);
        } catch (err) {
            console.error('Error in reject_winner_message:', err);
        }
    });

    // O(1) Disconnect handling with 45s Grace Period Reconnection
    socket.on('disconnect', () => {
        try {
            const sessionToken = socketSessionMap.get(socket.id);
            socketSessionMap.delete(socket.id);
            const code = cleanSocketState(socket.id);
            if (!code || !rooms[code]) return;

            const room = rooms[code];
            const session = sessionToken ? sessions.get(sessionToken) : null;

            if (room.host === socket.id) {
                // Host disconnected -> Start grace period timer
                if (session) {
                    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
                    session.cleanupTimer = setTimeout(() => {
                        if (rooms[code] && rooms[code].host === session.socketId) {
                            const finalResults = {
                                code: code,
                                teams: Object.entries(rooms[code].groups).map(([id, g]) => ({ name: g.name, points: g.points })),
                                disqualified: rooms[code].disqualified
                            };
                            io.to(code).emit('room_closed', finalResults);
                            delete rooms[code];
                            sessions.delete(sessionToken);
                        }
                    }, RECONNECT_GRACE_PERIOD_MS);
                } else {
                    const finalResults = {
                        code: code,
                        teams: Object.entries(room.groups).map(([id, g]) => ({ name: g.name, points: g.points })),
                        disqualified: room.disqualified
                    };
                    io.to(code).emit('room_closed', finalResults);
                    delete rooms[code];
                }
            } else {
                // Participant disconnected -> Mark disconnected status and start 3-minute grace period
                if (room.groups[socket.id]) {
                    room.groups[socket.id].disconnected = true;
                    io.to(room.host).emit('group_connection_status', {
                        socketId: socket.id,
                        name: room.groups[socket.id].name,
                        connected: false
                    });
                }
                if (session) {
                    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
                    session.cleanupTimer = setTimeout(() => {
                        const activeRoom = rooms[code];
                        if (activeRoom) {
                            const targetSockId = session.socketId;
                            let stateChanged = false;

                            if (activeRoom.groups[targetSockId]) {
                                const groupName = activeRoom.groups[targetSockId].name;
                                delete activeRoom.groups[targetSockId];
                                activeRoom.buzzes = activeRoom.buzzes.filter(b => b.socketId !== targetSockId);
                                activeRoom.buzzedSockets.delete(targetSockId);
                                stateChanged = true;

                                io.to(activeRoom.host).emit('group_left', { socketId: targetSockId, name: groupName });
                                io.to(code).emit('buzzes_update', activeRoom.buzzes);
                                io.to(code).emit('points_update', Object.entries(activeRoom.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
                            }

                            if (activeRoom.pendingRequests[targetSockId]) {
                                delete activeRoom.pendingRequests[targetSockId];
                                stateChanged = true;
                                io.to(activeRoom.host).emit('requests_update', Object.entries(activeRoom.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })));
                            }

                            if (activeRoom.activeViolations[targetSockId]) {
                                delete activeRoom.activeViolations[targetSockId];
                                stateChanged = true;
                            }

                            if (stateChanged) {
                                const remainingViolators = Object.values(activeRoom.activeViolations);
                                const remainingViolatorNames = remainingViolators.map(v => v.name || v);
                                const remainingPendingNames = Object.values(activeRoom.pendingRequests);

                                if (remainingViolatorNames.length > 0 || remainingPendingNames.length > 0 || activeRoom.manualFreeze) {
                                    io.to(code).emit('global_freeze', {
                                        violatorNames: remainingViolatorNames,
                                        pendingNames: remainingPendingNames,
                                        manualFreeze: activeRoom.manualFreeze
                                    });
                                } else {
                                    io.to(code).emit('violation_resolved', { action: 'disconnect', targetSocketId: targetSockId });
                                }

                                io.to(activeRoom.host).emit('tab_violation_alert', {
                                    violations: remainingViolators
                                });
                            }
                        }
                        sessions.delete(sessionToken);
                    }, RECONNECT_GRACE_PERIOD_MS);
                }
            }
        } catch (err) {
            console.error('Error in disconnect:', err);
        }
    });
});

// Periodic Server-Side Heartbeat / Presence Monitor (Every 5s)
setInterval(() => {
    try {
        const now = Date.now();
        for (const code in rooms) {
            const room = rooms[code];
            if (!room || !room.host) continue;

            for (const socketId in room.groups) {
                const group = room.groups[socketId];
                if (!group) continue;

                const lastHb = group.lastHeartbeat || now;
                // Flag if heartbeat missed for over 12 seconds (Connection loss tracking ONLY, NOT a cheating violation)
                if (now - lastHb > 12000 && !group.disconnected) {
                    group.disconnected = true;
                    io.to(room.host).emit('group_connection_status', {
                        socketId,
                        name: group.name,
                        connected: false
                    });
                }
            }
        }
    } catch (err) {
        console.error('Error in heartbeat interval:', err);
    }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

