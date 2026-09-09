const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());

// Time sync for nanosecond precision
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

// Serve static files from the Frontend directory
app.use(express.static(path.join(__dirname, '../Frontend')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
    }
});

// App State
// rooms: { roomId: { host: socketId, groups: { socketId: name }, buzzes: [ { socketId, name, timestamp } ], buzzesAllowed: true } }
const rooms = {};

// Helper to generate a random 4 letter code
function generateRoomCode() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < 4; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Host creates a room
    socket.on('create_room', () => {
        let code;
        do {
            code = generateRoomCode();
        } while (rooms[code]);

        rooms[code] = {
            host: socket.id,
            groups: {}, // maps socketId -> { name, points }
            buzzes: [],
            buzzesAllowed: false, // Start with buzzers disabled
            manualFreeze: false, // Manual override by host
            disqualified: [],
            activeViolations: {}, // maps socketId -> name
            pendingRequests: {} // maps socketId -> name
        };

        socket.join(code);
        socket.emit('room_created', code);
        console.log(`Room created: ${code} by host: ${socket.id}`);
    });

    // Group starts joining a room (request)
    socket.on('join_room', ({ code, name }) => {
        if (!code || typeof code !== 'string' || !name || typeof name !== 'string') {
            socket.emit('error', 'Invalid room code or group name.');
            return;
        }
        code = code.trim().toUpperCase();
        name = name.trim();
        if (!code || !name) {
            socket.emit('error', 'Room code and group name are required.');
            return;
        }
        const room = rooms[code];
        if (!room) {
            socket.emit('error', 'Room not found.');
            return;
        }

        const existingNames = Object.values(room.groups).map(g => g.name);
        const pendingNames = Object.values(room.pendingRequests);
        if (existingNames.includes(name) || pendingNames.includes(name)) {
            socket.emit('error', 'Name already taken or pending approval.');
            return;
        }

        // Add to pending
        room.pendingRequests[socket.id] = name;

        // Freeze everyone while host reviews join request (including the new one)
        const allPendingNames = Object.values(room.pendingRequests);
        const violatorNames = Object.values(room.activeViolations);
        io.to(code).emit('global_freeze', {
            pendingNames: allPendingNames,
            violatorNames,
            manualFreeze: room.manualFreeze
        });

        // Notify host
        io.to(room.host).emit('join_request', { socketId: socket.id, name });
        io.to(room.host).emit('requests_update', Object.entries(room.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })));
        socket.emit('waiting_for_approval');
        console.log(`Join request from ${name} (${socket.id}) for room ${code}`);
    });

    // Host resolves join request
    socket.on('resolve_join', ({ code, targetSocketId, action }) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;

        const name = room.pendingRequests[targetSocketId];
        if (!name) return;

        if (action === 'allow') {
            room.groups[targetSocketId] = { name, points: 0 };
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                targetSocket.join(code);
                targetSocket.emit('joined_room', { code, name, buzzesAllowed: room.buzzesAllowed });

                // Notify host that group joined successfully
                io.to(room.host).emit('group_joined', { socketId: targetSocketId, name, points: 0 });

                // Broadcast initial points
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

        // Check if anything else is keeping the room frozen
        const remainingPending = Object.values(room.pendingRequests);
        const remainingViolating = Object.values(room.activeViolations);

        if (remainingPending.length > 0 || remainingViolating.length > 0 || room.manualFreeze) {
            io.to(code).emit('global_freeze', {
                pendingNames: remainingPending,
                violatorNames: remainingViolating,
                manualFreeze: room.manualFreeze
            });
            io.to(room.host).emit('tab_violation_alert', {
                violations: Object.entries(room.activeViolations).map(([id, name]) => ({ socketId: id, name }))
            });
        } else {
            io.to(code).emit('violation_resolved', { action: 'join_resolved', targetSocketId });
            io.to(room.host).emit('tab_violation_alert', { violations: [] });
        }

        // Update host requests list
        io.to(room.host).emit('requests_update', Object.entries(room.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })));
    });

    // Group presses the buzzer
    socket.on('buzz', (code) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room) return;

        // Check if buzzers are allowed and user hasn't buzzed yet
        if (!room.buzzesAllowed) return;

        const hasBuzzed = room.buzzes.some(b => b.socketId === socket.id);
        if (hasBuzzed) return;

        const group = room.groups[socket.id];
        if (!group) return; // Not a registered group

        // SERVER-SIDE BUZZ PROTECTION: Reject buzz if participant has active violation
        if (room.activeViolations[socket.id]) {
            socket.emit('buzz_rejected', {
                reason: 'VIOLATION_ACTIVE',
                message: 'You have an active violation. Host must resolve your status before you can buzz.'
            });
            return;
        }

        const name = group.name;

        const buzzData = {
            socketId: socket.id,
            name: name,
            timeStr: getMicrosecondTime()
        };

        room.buzzes.push(buzzData);

        // Let the user know they buzzed successfully
        socket.emit('buzz_registered', { rank: room.buzzes.length });

        // Broadcast all buzzes to the entire room
        io.to(code).emit('buzzes_update', room.buzzes);
    });

    // Host resets buzzers
    socket.on('reset_buzzers', (code) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];

        // Ensure only host can do this
        if (!room || room.host !== socket.id) return;

        room.buzzes = [];
        room.buzzesAllowed = false; // Reset puts buzzers into OFF mode

        // Notify all to clear their buzzer lists
        io.to(code).emit('buzzes_update', room.buzzes);

        // Broadcast buzzer state turned OFF to all
        io.to(code).emit('buzzer_state', { active: false });

        // Notify all groups to reset their buzzer UI
        io.to(code).emit('reset', { buzzesAllowed: false });
        console.log(`Buzzers reset to OFF for room ${code}`);
    });

    // Host toggles buzzers
    socket.on('toggle_buzzers', ({ code, active }) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;

        room.buzzesAllowed = active;
        if (!active) {
            room.buzzes = []; // optionally clear when disabling
            io.to(code).emit('buzzes_update', room.buzzes);
        }
        io.to(code).emit('buzzer_state', { active });
        console.log(`Buzzers toggled for room ${code}: ${active}`);
    });

    // Host toggles manual freeze
    socket.on('toggle_manual_freeze', ({ code, freeze }) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;

        room.manualFreeze = freeze;
        if (freeze) {
            const pendingNames = Object.values(room.pendingRequests);
            const violatorNames = Object.values(room.activeViolations);
            io.to(code).emit('global_freeze', {
                pendingNames,
                violatorNames,
                manualFreeze: true
            });
        } else {
            const pendingNames = Object.values(room.pendingRequests);
            const violatorNames = Object.values(room.activeViolations);
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
    });

    // Host updates points
    socket.on('update_points', ({ code, targetSocketId, delta }) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;

        const deltaVal = parseInt(delta, 10);
        if (isNaN(deltaVal)) return;

        if (room.groups[targetSocketId]) {
            room.groups[targetSocketId].points += deltaVal;
            io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
        }
    });

    // Participant Heartbeat Handler
    socket.on('participant_heartbeat', ({ code, groupName, visibilityState, hasFocus }) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room) return;

        const group = room.groups[socket.id];
        if (group) {
            group.lastHeartbeat = Date.now();
            group.visibilityState = visibilityState;
            group.hasFocus = hasFocus;
        }
    });

    // Participant Returned Handler
    socket.on('participant_returned', ({ code }) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
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
    });

    socket.on('tab_violation', (data) => {
        if (!data) return;
        let code = typeof data === 'string' ? data : data.code;
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room) return;

        const group = room.groups[socket.id];
        const groupName = group ? group.name : room.pendingRequests[socket.id];
        if (groupName) {
            const type = typeof data === 'object' && data.type ? data.type : 'TAB_SWITCH';
            const date = new Date();
            const timeStr = date.toTimeString().split(' ')[0];

            room.activeViolations[socket.id] = {
                socketId: socket.id,
                name: groupName,
                type: type,
                timeStr: timeStr,
                fullscreen: typeof data === 'object' ? !!data.fullscreen : false,
                visibilityState: typeof data === 'object' && data.visibilityState ? data.visibilityState : 'hidden',
                hasFocus: typeof data === 'object' && typeof data.hasFocus === 'boolean' ? data.hasFocus : false,
                details: typeof data === 'object' && data.details ? data.details : 'Participant switched focus or exited page',
                status: 'Waiting for re-entry',
                timestamp: Date.now()
            };

            // Broadcast ALL reasons currently freezing the room
            const violatorNames = Object.values(room.activeViolations).map(v => v.name || v);
            const pendingNames = Object.values(room.pendingRequests);
            io.to(code).emit('global_freeze', {
                violatorNames,
                pendingNames,
                manualFreeze: room.manualFreeze
            });

            // Specifically notify host with the full list of rich violation details
            io.to(room.host).emit('tab_violation_alert', {
                violations: Object.values(room.activeViolations)
            });
        }
    });

    // Host Resolves Violation
    socket.on('resolve_violation', ({ code, targetSocketId, action }) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;

        if (action === 'disqualify') {
            const group = room.groups[targetSocketId];
            if (group) {
                // Add to disqualified list
                room.disqualified.push(group.name);
                delete room.groups[targetSocketId];

                // Remove their buzzes
                room.buzzes = room.buzzes.filter(b => b.socketId !== targetSocketId);

                // Broadcast updates to entire room
                io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
                io.to(code).emit('buzzes_update', room.buzzes);
                io.to(room.host).emit('disqualified_update', room.disqualified);
            }
        }

        // Remove from active tracking
        delete room.activeViolations[targetSocketId];

        const remainingViolators = Object.values(room.activeViolations);
        const remainingViolatorNames = remainingViolators.map(v => v.name || v);
        const remainingPendingNames = Object.values(room.pendingRequests);

        if (remainingViolatorNames.length > 0 || remainingPendingNames.length > 0 || room.manualFreeze) {
            // Still frozen for some reason
            io.to(code).emit('global_freeze', {
                violatorNames: remainingViolatorNames,
                pendingNames: remainingPendingNames,
                manualFreeze: room.manualFreeze
            });

            // If there were violators, update host's violation panel
            if (remainingViolators.length > 0) {
                io.to(room.host).emit('tab_violation_alert', {
                    violations: remainingViolators
                });
            } else {
                // If NO violators but still frozen (members pending or manual), close violation alert
                io.to(room.host).emit('tab_violation_alert', { violations: [] });
            }
        } else {
            // All reasons cleared (no violators AND no pending requests AND no manual freeze)
            io.to(code).emit('violation_resolved', { action, targetSocketId });
            io.to(room.host).emit('tab_violation_alert', { violations: [] });
        }

        // Tell the specific violator their fate
        io.to(targetSocketId).emit('individual_result', action);
    });

    // Host ends quiz manually
    socket.on('room_closed_trigger', (code) => {
        if (!code || typeof code !== 'string') return;
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;

        const finalResults = {
            code: code,
            teams: Object.entries(room.groups).map(([id, g]) => ({ name: g.name, points: g.points })),
            disqualified: room.disqualified
        };

        io.to(code).emit('room_closed', finalResults);
        delete rooms[code];
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        for (const code in rooms) {
            const room = rooms[code];
            if (room.host === socket.id) {
                const finalResults = {
                    code: code,
                    teams: Object.entries(room.groups).map(([id, g]) => ({ name: g.name, points: g.points })),
                    disqualified: room.disqualified
                };
                io.to(code).emit('room_closed', finalResults);
                delete rooms[code];
            } else {
                let stateChanged = false;

                if (room.groups[socket.id]) {
                    const groupName = room.groups[socket.id].name;
                    delete room.groups[socket.id];
                    room.buzzes = room.buzzes.filter(b => b.socketId !== socket.id);
                    stateChanged = true;

                    io.to(room.host).emit('group_left', { socketId: socket.id, name: groupName });
                    io.to(code).emit('buzzes_update', room.buzzes);
                    io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
                }

                if (room.pendingRequests[socket.id]) {
                    delete room.pendingRequests[socket.id];
                    stateChanged = true;
                    io.to(room.host).emit('requests_update', Object.entries(room.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })));
                }

                if (room.activeViolations[socket.id]) {
                    delete room.activeViolations[socket.id];
                    stateChanged = true;
                }

                if (stateChanged) {
                    const remainingViolators = Object.values(room.activeViolations);
                    const remainingViolatorNames = remainingViolators.map(v => v.name || v);
                    const remainingPendingNames = Object.values(room.pendingRequests);

                    if (remainingViolatorNames.length > 0 || remainingPendingNames.length > 0 || room.manualFreeze) {
                        io.to(code).emit('global_freeze', {
                            violatorNames: remainingViolatorNames,
                            pendingNames: remainingPendingNames,
                            manualFreeze: room.manualFreeze
                        });
                    } else {
                        io.to(code).emit('violation_resolved', { action: 'disconnect', targetSocketId: socket.id });
                    }

                    io.to(room.host).emit('tab_violation_alert', {
                        violations: remainingViolators
                    });
                }
            }
        }
    });
});

// Periodic Server-Side Heartbeat / Presence Monitor (Check every 5 seconds)
setInterval(() => {
    const now = Date.now();
    for (const code in rooms) {
        const room = rooms[code];
        if (!room || !room.host) continue;

        let violationsUpdated = false;
        for (const socketId in room.groups) {
            const group = room.groups[socketId];
            if (!group) continue;

            const lastHb = group.lastHeartbeat || now;
            // Flag if heartbeat missed for over 12 seconds
            if (now - lastHb > 12000 && !room.activeViolations[socketId]) {
                const date = new Date();
                const timeStr = date.toTimeString().split(' ')[0];
                room.activeViolations[socketId] = {
                    socketId,
                    name: group.name,
                    type: 'HEARTBEAT_TIMEOUT',
                    timeStr: timeStr,
                    fullscreen: group.fullscreen || false,
                    visibilityState: group.visibilityState || 'unknown',
                    hasFocus: group.hasFocus || false,
                    details: 'No heartbeat received from device for 12+ seconds',
                    timestamp: now
                };
                violationsUpdated = true;
            }
        }

        if (violationsUpdated) {
            const remainingViolators = Object.values(room.activeViolations);
            const violatorNames = remainingViolators.map(v => v.name || v);
            const pendingNames = Object.values(room.pendingRequests);
            io.to(code).emit('global_freeze', {
                violatorNames,
                pendingNames,
                manualFreeze: room.manualFreeze
            });
            io.to(room.host).emit('tab_violation_alert', {
                violations: remainingViolators
            });
        }
    }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
