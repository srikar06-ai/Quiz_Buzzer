const socket = io();

// DOM Elements
const views = {
    home: document.getElementById('home-view'),
    host: document.getElementById('host-view'),
    player: document.getElementById('player-view')
};

// Home Elements
const btnCreateRoom = document.getElementById('btn-create-room');
const btnJoinRoom = document.getElementById('btn-join-room');
const inputRoomCode = document.getElementById('input-room-code');
const inputGroupName = document.getElementById('input-group-name');

// Host Elements
const displayRoomCode = document.getElementById('display-room-code');
const btnResetBuzzers = document.getElementById('btn-reset-buzzers');
const btnToggleFreeze = document.getElementById('btn-toggle-freeze');
const btnToggleBuzzers = document.getElementById('btn-toggle-buzzers');
const teamsList = document.getElementById('teams-list');
const teamsCount = document.getElementById('teams-count');
const buzzesList = document.getElementById('buzzes-list');

// Player Elements
const displayGroupName = document.getElementById('display-group-name');
const playerRoomCode = document.getElementById('player-room-code');
const buzzerBtn = document.getElementById('buzzer-btn');
const buzzerText = buzzerBtn.querySelector('.buzzer-text');
const playerStatusText = document.getElementById('player-status-text');
const playerPointsList = document.getElementById('player-points-list');
const toastEl = document.getElementById('toast');

// Modal Elements
const redWarningModal = document.getElementById('red-warning-modal');
const btnWarningStay = document.getElementById('btn-warning-stay');
const btnWarningLeave = document.getElementById('btn-warning-leave');
const freezeModal = document.getElementById('freeze-modal');
const disqualifiedModal = document.getElementById('disqualified-modal');
const globalFreezeText = document.getElementById('global-freeze-text');

// Host Modal Elements
const hostAlertModal = document.getElementById('host-alert-modal');
const violatorListContainer = document.getElementById('violator-list-container');
const disqualifiedList = document.getElementById('disqualified-list');
const requestsList = document.getElementById('requests-list');
const btnEndQuiz = document.getElementById('btn-end-quiz');
const waitingModal = document.getElementById('waiting-modal');

// Host Confirm Modal
const hostConfirmModal = document.getElementById('host-confirm-modal');
const disqualifyMsg = document.getElementById('disqualify-msg');
const btnConfirmDisqualify = document.getElementById('btn-confirm-disqualify');
const btnCancelDisqualify = document.getElementById('btn-cancel-disqualify');

// State
let pendingDisqualifySocketId = null;
let currentRoomCode = '';
let currentGroupName = '';
let isHost = false;
let isBuzzerActive = true;
let wakeLock = null;

// Host Window Protection
window.addEventListener('beforeunload', (e) => {
    if (isHost && currentRoomCode) {
        e.preventDefault();
        e.returnValue = ''; // Standard way to show confirmation
        return 'Are you sure you want to end the quiz?';
    }
});

// ----------------- Helpers -----------------

function switchView(viewName) {
    Object.values(views).forEach(v => {
        v.classList.remove('active');
        v.classList.add('hidden');
    });
    views[viewName].classList.remove('hidden');
    views[viewName].classList.add('active');
}

function showToast(message, type = 'info') {
    toastEl.textContent = message;
    if (type === 'error') {
        toastEl.style.borderLeftColor = 'var(--danger)';
    } else if (type === 'success') {
        toastEl.style.borderLeftColor = 'var(--success)';
    } else {
        toastEl.style.borderLeftColor = 'var(--primary-color)';
    }

    toastEl.classList.add('show');
    setTimeout(() => {
        toastEl.classList.remove('show');
    }, 3000);
}

// Global copy function for the room code
window.copyRoomCode = async () => {
    try {
        await navigator.clipboard.writeText(currentRoomCode);
        showToast('Room Code copied to clipboard', 'success');
    } catch (err) {
        showToast('Failed to copy', 'error');
    }
}

// ----------------- Event Listeners (UI) -----------------

btnCreateRoom.addEventListener('click', () => {
    socket.emit('create_room');
});

btnJoinRoom.addEventListener('click', () => {
    const code = inputRoomCode.value.trim().toUpperCase();
    const name = inputGroupName.value.trim();

    // Trigger full-screen immediately on this gesture
    requestFullScreen();

    if (!code || code.length !== 4) {
        showToast('Please enter a valid 4-letter room code', 'error');
        return;
    }
    if (!name) {
        showToast('Please enter your group name', 'error');
        return;
    }

    socket.emit('join_room', { code, name });
});

buzzerBtn.addEventListener('click', () => {
    // Only buzz if it is active (not buzzed and buzzers allowed)
    if (buzzerBtn.classList.contains('active')) {
        // Optimistic UI update
        buzzerBtn.classList.remove('active');
        buzzerBtn.classList.add('pressed');

        setTimeout(() => buzzerBtn.classList.remove('pressed'), 150);

        socket.emit('buzz', currentRoomCode);
    }
});

btnResetBuzzers.addEventListener('click', () => {
    socket.emit('reset_buzzers', currentRoomCode);
    isBuzzerActive = true;
    if (btnToggleBuzzers) btnToggleBuzzers.textContent = 'Disable Buzzers';
});

if (btnToggleBuzzers) {
    btnToggleBuzzers.addEventListener('click', () => {
        isBuzzerActive = !isBuzzerActive;
        socket.emit('toggle_buzzers', { code: currentRoomCode, active: isBuzzerActive });
        btnToggleBuzzers.textContent = isBuzzerActive ? 'Disable Buzzers' : 'Enable Buzzers';
    });
}

// Global update points function for Host controls
window.updatePoints = (targetSocketId, delta) => {
    socket.emit('update_points', { code: currentRoomCode, targetSocketId, delta });
};

// Use touchstart for faster response on mobile
buzzerBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    buzzerBtn.click();
}, { passive: false });


// ----------------- Socket.IO Listeners -----------------

socket.on('error', (msg) => {
    showToast(msg, 'error');
    if (waitingModal) waitingModal.classList.add('hidden');
});

// Fullscreen & Wake Lock Helpers
window.requestFullScreen = async function () {
    try {
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            if (document.documentElement.requestFullscreen) {
                await document.documentElement.requestFullscreen();
            } else if (document.documentElement.webkitRequestFullscreen) {
                await document.documentElement.webkitRequestFullscreen();
            }
        }
        // Keep screen awake
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (e) {
        console.log("Immersive mode blocked:", e);
        showToast('Please tap "Go Fullscreen" to enable protections', 'info');
    }
}

// Re-request on any modal interaction (to fix mobile block)
if (freezeModal) freezeModal.addEventListener('click', requestFullScreen);
if (redWarningModal) redWarningModal.addEventListener('click', requestFullScreen);

async function releaseImmersiveMode() {
    try {
        if (document.exitFullscreen) await document.exitFullscreen();
        if (wakeLock) {
            await wakeLock.release();
            wakeLock = null;
        }
    } catch (e) { console.log(e); }
}

// HOST: End Quiz
if (btnEndQuiz) {
    btnEndQuiz.addEventListener('click', () => {
        if (confirm('Are you sure you want to end the quiz? This will close the room for everyone.')) {
            socket.emit('toggle_buzzers', { code: currentRoomCode, active: false });
            // The room will be closed on disconnect or we can emit a close event
            socket.emit('room_closed_trigger', currentRoomCode);
        }
    });
}

// HOST: Room created
socket.on('room_created', (code) => {
    isHost = true;
    currentRoomCode = code;
    displayRoomCode.textContent = code;
    switchView('host');
    showToast('Room created successfully', 'success');
});

// PLAYER: Waiting for approval
socket.on('waiting_for_approval', () => {
    if (waitingModal) waitingModal.classList.remove('hidden');
});

// HOST: Join Request Received
socket.on('join_request', (data) => {
    if (!isHost) return;
    showToast(`New join request: ${data.name}`, 'info');
    // Requests list will be updated by requests_update
});

// HOST: Update Requests List
socket.on('requests_update', (requests) => {
    if (!isHost || !requestsList) return;

    requestsList.innerHTML = '';
    if (requests.length === 0) {
        requestsList.innerHTML = '<li class="empty-state">No pending requests</li>';
        return;
    }

    requests.forEach(req => {
        const li = document.createElement('li');
        li.className = 'team-item';
        li.style = 'display:flex; justify-content:space-between; align-items:center;';
        li.innerHTML = `
            <span style="font-weight:600;">${req.name}</span>
            <div style="display:flex; gap:0.5rem;">
                <button class="btn primary-btn" style="padding:0.4rem 0.8rem; font-size:0.8rem;" onclick="resolveJoin('${req.socketId}', 'allow')">Allow</button>
                <button class="btn warning-btn" style="padding:0.4rem 0.8rem; font-size:0.8rem;" onclick="resolveJoin('${req.socketId}', 'reject')">Reject</button>
            </div>
        `;
        requestsList.appendChild(li);
    });
});

window.resolveJoin = (targetSocketId, action) => {
    socket.emit('resolve_join', { code: currentRoomCode, targetSocketId, action });
};

// PLAYER: Joined room successfully
socket.on('joined_room', (data) => {
    if (waitingModal) waitingModal.classList.add('hidden');
    currentRoomCode = data.code;
    currentGroupName = data.name;

    displayGroupName.textContent = currentGroupName;
    playerRoomCode.textContent = currentRoomCode;

    if (data.buzzesAllowed) {
        setPlayerBuzzerState('active');
    } else {
        setPlayerBuzzerState('disabled');
    }

    switchView('player');
    requestFullScreen();
    showToast('Joined Room!', 'success');
});

// PLAYER: Buzz response from server
socket.on('buzz_registered', (data) => {
    setPlayerBuzzerState('buzzed', data.rank);
});

// EVERYONE: Buzzers active/inactive toggle
socket.on('buzzer_state', (data) => {
    if (!isHost) {
        if (data.active) setPlayerBuzzerState('active');
        else setPlayerBuzzerState('disabled');
    }
});

// EVERYONE: Points Leaderboard Update
socket.on('points_update', (teamsWithPoints) => {
    if (isHost) {
        connectedTeams = teamsWithPoints;
        renderTeams();
    } else {
        renderPlayerPoints(teamsWithPoints);
    }
});

// PLAYER: Host reset buzzers
socket.on('reset', (data) => {
    if (data.buzzesAllowed) {
        setPlayerBuzzerState('active');
        showToast('Buzzers Reset! Get Ready.', 'info');
    }
});

// HOST / PLAYER: Room closed
socket.on('room_closed', () => {
    showToast('Room was closed by the host', 'error');
    releaseImmersiveMode();
    setTimeout(() => {
        window.location.reload();
    }, 2000);
});

// HOST: New group joined
let connectedTeams = [];
socket.on('group_joined', (data) => {
    if (!isHost) return;

    connectedTeams.push(data);
    renderTeams();
    showToast(`${data.name} just joined!`, 'success');
});

// HOST: Group left
socket.on('group_left', (data) => {
    if (!isHost) return;

    connectedTeams = connectedTeams.filter(t => t.socketId !== data.socketId);
    renderTeams();
    showToast(`${data.name} left the room`, 'warning');
});

// HOST: Buzz updates (Array of { socketId, name, timestamp })
socket.on('buzzes_update', (buzzes) => {
    if (!isHost) return;
    renderBuzzes(buzzes);
});

// HOST: Disqualified updates
socket.on('disqualified_update', (disqualified) => {
    if (!isHost) return;
    renderDisqualified(disqualified);
});

// Host: Manual Freeze
if (btnToggleFreeze) {
    btnToggleFreeze.addEventListener('click', () => {
        const currentlyFrozen = btnToggleFreeze.classList.contains('active-action');
        socket.emit('toggle_manual_freeze', { code: currentRoomCode, freeze: !currentlyFrozen });
    });
}

socket.on('manual_freeze_status', ({ freeze }) => {
    if (freeze) {
        btnToggleFreeze.classList.add('active-action');
        btnToggleFreeze.innerHTML = 'Unfreeze Room';
        btnToggleFreeze.style.background = '#ef4444';
    } else {
        btnToggleFreeze.classList.remove('active-action');
        btnToggleFreeze.innerHTML = 'Freeze Room';
        btnToggleFreeze.style.background = '#8b5cf6';
    }
});

// HOST: Disqualified updates
socket.on('disqualified_update', (disqualified) => {
    if (!isHost) return;
    renderDisqualified(disqualified);
});

// HOST: Disqualified updates (on reconnect or room load if needed)
function renderDisqualified(disqualified) {
    if (!disqualifiedList) return;
    disqualifiedList.innerHTML = '';
    if (disqualified.length === 0) {
        disqualifiedList.innerHTML = '<li class="empty-state">No disqualified players</li>';
        return;
    }
    disqualified.forEach(name => {
        const li = document.createElement('li');
        li.className = 'team-item';
        li.style = 'background:rgba(239, 68, 68, 0.1); border-left: 3px solid #ef4444;';
        li.innerHTML = `<span style="color:#ef4444">❌ ${name}</span>`;
        disqualifiedList.appendChild(li);
    });
}

// TAB VIOLATION LOGIC
let lastViolatorSocketId = null;

// Player: document visibility change (tab switch)
function triggerViolationWarning() {
    if (!isHost && views['player'].classList.contains('active')) {
        // Immediate violation emission (No warning modal choice)
        socket.emit('tab_violation', currentRoomCode);
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === 'hidden') {
        triggerViolationWarning();
    }
});

// Windows/Mobile blur detection
window.addEventListener("blur", () => {
    triggerViolationWarning();
});

// Shortcut Blocking (Aggressive)
document.addEventListener('keydown', (e) => {
    if (isHost) return;

    // Block Alt+Tab (simulated), F12, Ctrl+Shift+I, etc.
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
        e.preventDefault();
        return false;
    }

    // Warn on Escape
    if (e.key === 'Escape') {
        e.preventDefault();
        requestFullScreen();
    }
});

// Block Context Menu
document.addEventListener('contextmenu', (e) => {
    if (!isHost) e.preventDefault();
});

// Global Freeze Listener
socket.on('global_freeze', ({ violatorNames, pendingNames, manualFreeze }) => {
    if (isHost) return;
    if (globalFreezeText) {
        let msg = '';
        if (manualFreeze) {
            msg += `🔒 <strong style="color:var(--primary-color)">Room is manually frozen by Host</strong>.<br>`;
        }
        if (violatorNames && violatorNames.length > 0) {
            const names = violatorNames.join("', '");
            msg += `⚠️ <strong style="color:var(--danger)">Teams '${names}'</strong> are trying to open other tabs!<br>`;
        }
        if (pendingNames && pendingNames.length > 0) {
            const names = pendingNames.join("', '");
            msg += `📨 <strong style="color:var(--secondary)">Teams '${names}'</strong> are requesting to join!<br>`;
        }

        if (!msg) msg = 'Page is frozen by Host.';

        globalFreezeText.innerHTML = msg;
    }
    if (freezeModal) freezeModal.classList.remove('hidden');
});

// Host: Tab Violation Alert Received (Multiple)
socket.on('tab_violation_alert', ({ violations }) => {
    if (!isHost) return;

    if (violatorListContainer) {
        violatorListContainer.innerHTML = '';
        if (violations.length === 0) {
            if (hostAlertModal) hostAlertModal.classList.add('hidden');
            return;
        }

        violations.forEach(v => {
            const div = document.createElement('div');
            div.style = 'display:flex; justify-content:space-between; align-items:center; background:rgba(255,0,0,0.1); padding:0.8rem; border-radius:8px; margin-bottom:0.5rem; border:1px solid rgba(255,0,0,0.2);';
            div.innerHTML = `
                <span style="font-weight:700;">${v.name}</span>
                <div style="display:flex; gap:0.5rem;">
                    <button class="btn warning-btn" style="padding:0.4rem 0.8rem; font-size:0.8rem;" onclick="resolveTeam('${v.socketId}', 'disqualify')">Disqualify</button>
                    <button class="btn secondary-btn" style="padding:0.4rem 0.8rem; font-size:0.8rem;" onclick="resolveTeam('${v.socketId}', 'letgo')">Let Go</button>
                </div>
            `;
            violatorListContainer.appendChild(div);
        });
    }

    if (hostAlertModal && violations.length > 0) hostAlertModal.classList.remove('hidden');
});

// Global resolution helper for host
window.resolveTeam = (socketId, action) => {
    socket.emit('resolve_violation', { code: currentRoomCode, targetSocketId: socketId, action });
};

// Host: Resolve UI updates
socket.on('violation_resolved', ({ action, targetSocketId }) => {
    // If host, just hide our local violation modal
    if (isHost) {
        if (hostAlertModal) hostAlertModal.classList.add('hidden');
        return;
    }

    // Participants: hide the freeze overlay
    if (freezeModal) freezeModal.classList.add('hidden');

    if (action === 'letgo') {
        showToast('Host resumed the game!', 'success');
    } else if (action === 'join_resolved') {
        showToast('Host resolved join requests!', 'success');
    } else if (action === 'manual_unfreeze') {
        showToast('Host unfrozen the room!', 'success');
    } else if (action === 'disqualify') {
        if (socket.id === targetSocketId) {
            if (disqualifiedModal) disqualifiedModal.classList.remove('hidden');
            releaseImmersiveMode();
        } else {
            showToast('A violator was disqualified. Game resumes.', 'warning');
        }
    }
});

// ----------------- Render Functions -----------------

function renderTeams() {
    teamsCount.textContent = connectedTeams.length;

    if (connectedTeams.length === 0) {
        teamsList.innerHTML = `<li class="empty-state">Waiting for players to join...</li>`;
        return;
    }

    teamsList.innerHTML = '';

    // Sort teams by points descending
    const sortedTeams = [...connectedTeams].sort((a, b) => (b.points || 0) - (a.points || 0));

    sortedTeams.forEach(team => {
        const li = document.createElement('li');
        const points = team.points || 0;
        li.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                <div style="display:flex; align-items:center; gap:0.5rem;">
                    <button class="btn warning-btn" style="padding:0.3rem 0.5rem; font-size:0.7rem; background:#ef4444;" onclick="requestDisqualify('${team.socketId}', '${team.name}')">❌</button>
                    <span>${team.name}</span>
                </div>
                <div class="pt-controls">
                    <button class="pt-btn" onclick="updatePoints('${team.socketId}', -10)">-</button>
                    <div class="pt-score">${points}</div>
                    <button class="pt-btn" onclick="updatePoints('${team.socketId}', 10)">+</button>
                </div>
            </div>
        `;
        teamsList.appendChild(li);
    });
}

// Host: Manual Disqualify Flow
window.requestDisqualify = (socketId, name) => {
    pendingDisqualifySocketId = socketId;
    if (disqualifyMsg) disqualifyMsg.innerHTML = `Are you sure you want to disqualify <strong>'${name}'</strong>?`;

    // Freeze room while host decides
    socket.emit('toggle_manual_freeze', { code: currentRoomCode, freeze: true });

    if (hostConfirmModal) hostConfirmModal.classList.remove('hidden');
};

if (btnConfirmDisqualify) {
    btnConfirmDisqualify.addEventListener('click', () => {
        if (pendingDisqualifySocketId) {
            socket.emit('resolve_violation', {
                code: currentRoomCode,
                targetSocketId: pendingDisqualifySocketId,
                action: 'disqualify'
            });
        }
        socket.emit('toggle_manual_freeze', { code: currentRoomCode, freeze: false });
        if (hostConfirmModal) hostConfirmModal.classList.add('hidden');
        pendingDisqualifySocketId = null;
    });
}

if (btnCancelDisqualify) {
    btnCancelDisqualify.addEventListener('click', () => {
        socket.emit('toggle_manual_freeze', { code: currentRoomCode, freeze: false });
        if (hostConfirmModal) hostConfirmModal.classList.add('hidden');
        pendingDisqualifySocketId = null;
    });
}

function renderBuzzes(buzzes) {
    if (buzzes.length === 0) {
        buzzesList.innerHTML = `
            <div class="empty-state large">
                <div class="icon-pulse">🔔</div>
                <p>Waiting for buzzes...</p>
            </div>`;
        return;
    }

    buzzesList.innerHTML = '';
    buzzes.forEach((buzz, index) => {
        const li = document.createElement('li');
        li.className = 'buzz-item';
        if (index === 0) li.classList.add('first-place');

        let rankStr = `#${index + 1}`;

        // Calculate time difference if not first place
        let timeDiffText = '';
        if (index > 0) {
            const diff = buzz.timestamp - buzzes[0].timestamp;
            timeDiffText = `(+${diff}µs)`;
        } else {
            timeDiffText = `(+0µs)`;
        }

        li.innerHTML = `
            <span class="rank">${rankStr}</span>
            <span class="team-name">${buzz.name}</span>
            <span class="time-diff">${timeDiffText}</span>
        `;

        buzzesList.appendChild(li);
    });
}

function setPlayerBuzzerState(state, rank = null) {
    buzzerBtn.className = 'buzzer-btn'; // reset

    if (state === 'active') {
        buzzerBtn.classList.add('active');
        buzzerText.textContent = 'BUZZ';
        playerStatusText.textContent = 'Buzzer is active! Tap as fast as you can.';
        playerStatusText.style.color = 'var(--text-secondary)';
    }
    else if (state === 'buzzed') {
        buzzerBtn.classList.add('buzzed');
        buzzerText.textContent = `Buzzed!`;
        playerStatusText.textContent = `You buzzed in rank #${rank}`;
        if (rank === 1) {
            playerStatusText.style.color = 'var(--success)';
        } else {
            playerStatusText.style.color = 'var(--primary-color)';
        }
    }
    else if (state === 'disabled') {
        buzzerBtn.classList.add('disabled');
        buzzerBtn.classList.remove('active', 'buzzed');
        buzzerText.textContent = 'WAIT';
        playerStatusText.textContent = 'Waiting for host...';
        playerStatusText.style.color = 'var(--text-secondary)';
    }
}

function renderPlayerPoints(teamsWithPoints) {
    if (!playerPointsList) return;

    if (teamsWithPoints.length === 0) {
        playerPointsList.innerHTML = `<span class="empty-state">Waiting for scores...</span>`;
        return;
    }

    // Sort descending by points
    const sorted = [...teamsWithPoints].sort((a, b) => b.points - a.points);

    playerPointsList.innerHTML = '';
    sorted.forEach(team => {
        const div = document.createElement('div');
        div.className = 'points-pill';
        div.innerHTML = `<span>${team.name}</span> <span class="score">${team.points}</span>`;
        playerPointsList.appendChild(div);
    });
}

function renderDisqualified(disqualified) {
    if (!disqualifiedList) return;
    if (disqualified.length === 0) {
        disqualifiedList.innerHTML = `<li class="empty-state">None yet</li>`;
        return;
    }

    disqualifiedList.innerHTML = '';
    disqualified.forEach(name => {
        const li = document.createElement('li');
        li.style.color = '#ef4444';
        li.textContent = name;
        disqualifiedList.appendChild(li);
    });
}
