const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());

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
        code = code.toUpperCase();
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
        io.to(code).emit('global_freeze', { pendingNames: allPendingNames, violatorNames });

        // Notify host
        io.to(room.host).emit('join_request', { socketId: socket.id, name });
        io.to(room.host).emit('requests_update', Object.entries(room.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })));
        socket.emit('waiting_for_approval');
        console.log(`Join request from ${name} (${socket.id}) for room ${code}`);
    });

    // Host resolves join request
    socket.on('resolve_join', ({ code, targetSocketId, action }) => {
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

        // Check if anything else is keeping the room frozen
        const remainingPending = Object.values(room.pendingRequests);
        const remainingViolating = Object.values(room.activeViolations);

        if (remainingPending.length > 0 || remainingViolating.length > 0) {
            io.to(code).emit('global_freeze', {
                pendingNames: remainingPending,
                violatorNames: remainingViolating
            });
        } else {
            io.to(code).emit('violation_resolved', { action: 'join_resolved', targetSocketId });
        }

        // Update host requests list
        io.to(room.host).emit('requests_update', Object.entries(room.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })));
    });

    // Group presses the buzzer
    socket.on('buzz', (code) => {
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room) return;

        // Check if buzzers are allowed and user hasn't buzzed yet
        if (!room.buzzesAllowed) return;

        const hasBuzzed = room.buzzes.some(b => b.socketId === socket.id);
        if (hasBuzzed) return;

        const group = room.groups[socket.id];
        if (!group) return; // Not a registered group
        const name = group.name;

        const buzzData = {
            socketId: socket.id,
            name: name,
            // process.hrtime.bigint() returns nanoseconds, so divide by 1000n for microseconds
            timestamp: Number(process.hrtime.bigint() / 1000n)
        };

        room.buzzes.push(buzzData);

        // Let the user know they buzzed successfully
        socket.emit('buzz_registered', { rank: room.buzzes.length });

        // Broadcast all buzzes to host
        io.to(room.host).emit('buzzes_update', room.buzzes);
    });

    // Host resets buzzers
    socket.on('reset_buzzers', (code) => {
        code = code.toUpperCase();
        const room = rooms[code];

        // Ensure only host can do this
        if (!room || room.host !== socket.id) return;

        room.buzzes = [];
        room.buzzesAllowed = true;

        // Notify host
        socket.emit('buzzes_update', room.buzzes);

        // Notify all groups to reset their buzzer UI
        io.to(code).emit('reset', { buzzesAllowed: true });
        console.log(`Buzzers reset for room ${code}`);
    });

    // Host toggles buzzers
    socket.on('toggle_buzzers', ({ code, active }) => {
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;

        room.buzzesAllowed = active;
        if (!active) {
            room.buzzes = []; // optionally clear when disabling
            socket.emit('buzzes_update', room.buzzes);
        }
        io.to(code).emit('buzzer_state', { active });
        console.log(`Buzzers toggled for room ${code}: ${active}`);
    });

    // Host updates points
    socket.on('update_points', ({ code, targetSocketId, delta }) => {
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;

        if (room.groups[targetSocketId]) {
            room.groups[targetSocketId].points += parseInt(delta, 10);
            io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
        }
    });

    // Participant Tab Violation
    socket.on('tab_violation', (code) => {
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room) return;

        const group = room.groups[socket.id];
        if (group) {
            // Track this specific violation
            room.activeViolations[socket.id] = group.name;

            // Broadcast ALL reasons currently freezing the room
            const violatorNames = Object.values(room.activeViolations);
            const pendingNames = Object.values(room.pendingRequests);
            io.to(code).emit('global_freeze', { violatorNames, pendingNames });

            // Specifically notify host with the full list + socket details
            io.to(room.host).emit('tab_violation_alert', {
                violations: Object.entries(room.activeViolations).map(([id, name]) => ({ socketId: id, name }))
            });
        }
    });

    // Host Resolves Violation
    socket.on('resolve_violation', ({ code, targetSocketId, action }) => {
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

                // Broadcast updates
                io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
                io.to(room.host).emit('buzzes_update', room.buzzes);
                io.to(room.host).emit('disqualified_update', room.disqualified);
            }
        }

        // Remove from active tracking
        delete room.activeViolations[targetSocketId];

        const remainingViolatorNames = Object.values(room.activeViolations);
        const remainingPendingNames = Object.values(room.pendingRequests);

        if (remainingViolatorNames.length > 0 || remainingPendingNames.length > 0) {
            // Still frozen for some reason
            io.to(code).emit('global_freeze', {
                violatorNames: remainingViolatorNames,
                pendingNames: remainingPendingNames
            });

            // If there were violators, update host's violation panel
            if (remainingViolatorNames.length > 0) {
                io.to(room.host).emit('tab_violation_alert', {
                    violations: Object.entries(room.activeViolations).map(([id, name]) => ({ socketId: id, name }))
                });
            } else {
                // If NO violators but still frozen (members pending), close violation alert
                io.to(room.host).emit('tab_violation_alert', { violations: [] });
            }
        } else {
            // All reasons cleared (no violators AND no pending requests)
            io.to(code).emit('violation_resolved', { action, targetSocketId });
        }

        // Tell the specific violator their fate
        io.to(targetSocketId).emit('individual_result', action);
    });

    // Host ends quiz manually
    socket.on('room_closed_trigger', (code) => {
        code = code.toUpperCase();
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;
        io.to(code).emit('room_closed');
        delete rooms[code];
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        for (const code in rooms) {
            const room = rooms[code];
            if (room.host === socket.id) {
                io.to(code).emit('room_closed');
                delete rooms[code];
            } else if (room.groups[socket.id]) {
                const groupName = room.groups[socket.id].name;
                delete room.groups[socket.id];
                room.buzzes = room.buzzes.filter(b => b.socketId !== socket.id);

                if (room.activeViolations[socket.id]) {
                    delete room.activeViolations[socket.id];
                    const remainingViolatorNames = Object.values(room.activeViolations);
                    const remainingPendingNames = Object.values(room.pendingRequests);

                    if (remainingViolatorNames.length > 0 || remainingPendingNames.length > 0) {
                        io.to(code).emit('global_freeze', {
                            violatorNames: remainingViolatorNames,
                            pendingNames: remainingPendingNames
                        });
                        io.to(room.host).emit('tab_violation_alert', {
                            violations: Object.entries(room.activeViolations).map(([id, name]) => ({ socketId: id, name }))
                        });
                    } else {
                        io.to(code).emit('violation_resolved', { action: 'disconnect', targetSocketId: socket.id });
                    }
                }

                io.to(room.host).emit('group_left', { socketId: socket.id, name: groupName });
                io.to(room.host).emit('buzzes_update', room.buzzes);
                io.to(code).emit('points_update', Object.entries(room.groups).map(([id, g]) => ({ socketId: id, name: g.name, points: g.points })));
            } else if (room.pendingRequests[socket.id]) {
                delete room.pendingRequests[socket.id];
                const remainingViolatorNames = Object.values(room.activeViolations);
                const remainingPendingNames = Object.values(room.pendingRequests);

                if (remainingViolatorNames.length > 0 || remainingPendingNames.length > 0) {
                    io.to(code).emit('global_freeze', {
                        violatorNames: remainingViolatorNames,
                        pendingNames: remainingPendingNames
                    });
                } else {
                    io.to(code).emit('violation_resolved', { action: 'disconnect', targetSocketId: socket.id });
                }

                io.to(room.host).emit('requests_update', Object.entries(room.pendingRequests).map(([id, n]) => ({ socketId: id, name: n })));
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
