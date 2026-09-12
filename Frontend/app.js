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
const hostLeaderboardSummary = document.getElementById('host-leaderboard-summary');
const btnCopyLeaderboard = document.getElementById('btn-copy-leaderboard');

// Player Elements
const displayGroupName = document.getElementById('display-group-name');
const playerRoomCode = document.getElementById('player-room-code');
const buzzerBtn = document.getElementById('buzzer-btn');
const buzzerText = buzzerBtn.querySelector('.buzzer-text');
const playerStatusText = document.getElementById('player-status-text');
const playerBuzzesList = document.getElementById('player-buzzes-list');
const toastEl = document.getElementById('toast');

// Modal Elements
const redWarningModal = document.getElementById('red-warning-modal');
const btnWarningStay = document.getElementById('btn-warning-stay');
const btnWarningLeave = document.getElementById('btn-warning-leave');
const freezeModal = document.getElementById('freeze-modal');
const disqualifiedModal = document.getElementById('disqualified-modal');
const globalFreezeText = document.getElementById('global-freeze-text');
const fullscreenLockStatus = document.getElementById('fullscreen-lock-status');

// Host Modal Elements
const hostAlertModal = document.getElementById('host-alert-modal');
const violatorListContainer = document.getElementById('violator-list-container');
const disqualifiedList = document.getElementById('disqualified-list');
const requestsList = document.getElementById('requests-list');
const btnEndQuiz = document.getElementById('btn-end-quiz');
const waitingModal = document.getElementById('waiting-modal');
const leaderboardModal = document.getElementById('leaderboard-modal');
const leaderboardContainer = document.getElementById('leaderboard-container');
const btnDownloadPdf = document.getElementById('btn-download-pdf');

// Host Confirm Modal
const hostConfirmModal = document.getElementById('host-confirm-modal');
const disqualifyMsg = document.getElementById('disqualify-msg');
const btnConfirmDisqualify = document.getElementById('btn-confirm-disqualify');
const btnCancelDisqualify = document.getElementById('btn-cancel-disqualify');

// End Quiz Modal Elements
const endQuizModal = document.getElementById('end-quiz-modal');
const btnConfirmEndQuiz = document.getElementById('btn-confirm-end-quiz');
const btnCancelEndQuiz = document.getElementById('btn-cancel-end-quiz');

// Winner Modals
const winnerPromptModal = document.getElementById('winner-prompt-modal');
const winnerPromptMsg = document.getElementById('winner-prompt-msg');
const btnApproveWinner = document.getElementById('btn-approve-winner');
const btnRejectWinner = document.getElementById('btn-reject-winner');
const winnerCongratulationsModal = document.getElementById('winner-congratulations-modal');
const winnerCongratulationsScore = document.getElementById('winner-congratulations-score');
const btnCloseWinnerModal = document.getElementById('btn-close-winner-modal');

// State Machine & Lock Controls
const PLAYER_STATE = {
    NORMAL: 'NORMAL',
    VIOLATION: 'VIOLATION',
    WAITING_REENTRY: 'WAITING_REENTRY',
    RESTORED: 'RESTORED'
};
let playerState = PLAYER_STATE.NORMAL;
let isQuizLocked = false;

let lastGlobalResults = null;
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

function getOrCreateSessionToken() {
    let token = sessionStorage.getItem('quiz_session_token');
    if (!token) {
        token = 'sess_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
        sessionStorage.setItem('quiz_session_token', token);
    }
    return token;
}

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

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

async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
    } else {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        textArea.remove();
    }
}

// Copy Room Code event listener
if (displayRoomCode) {
    displayRoomCode.addEventListener('click', async () => {
        try {
            if (!currentRoomCode) return;
            await copyToClipboard(currentRoomCode);
            showToast('Room Code copied to clipboard', 'success');
        } catch (err) {
            showToast('Failed to copy', 'error');
        }
    });
}

// Copy Leaderboard event listener
if (btnCopyLeaderboard) {
    btnCopyLeaderboard.addEventListener('click', async () => {
        try {
            if (!connectedTeams || connectedTeams.length === 0) {
                showToast('No teams in leaderboard to copy', 'error');
                return;
            }
            const sortedTeams = [...connectedTeams].sort((a, b) => (b.points || 0) - (a.points || 0));

            // Create temporary container for html2canvas rendering
            const container = document.createElement('div');
            container.style.cssText = `
                position: fixed;
                left: -9999px;
                top: -9999px;
                background-color: #0f172a;
                color: #ffffff;
                padding: 24px;
                border-radius: 16px;
                width: 440px;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                box-shadow: 0 10px 25px rgba(0,0,0,0.5);
                z-index: -9999;
            `;

            const title = document.createElement('div');
            title.style.cssText = 'color: #38bdf8; font-size: 20px; font-weight: 700; margin-bottom: 20px; text-align: left;';
            title.textContent = `Leaderboard - Room ${currentRoomCode || ''}`;
            container.appendChild(title);

            const list = document.createElement('div');
            list.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

            sortedTeams.forEach((team, index) => {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: #1e293b; padding: 12px 16px; border-radius: 10px;';

                const left = document.createElement('div');
                left.style.cssText = 'display: flex; align-items: center; gap: 14px;';

                const rank = document.createElement('span');
                rank.style.cssText = 'color: #38bdf8; font-weight: 700; font-size: 16px; min-width: 30px;';
                rank.textContent = `#${index + 1}`;

                const name = document.createElement('span');
                name.style.cssText = 'color: #ffffff; font-weight: 600; font-size: 16px;';
                name.textContent = team.name;

                left.appendChild(rank);
                left.appendChild(name);

                const pts = document.createElement('span');
                pts.style.cssText = 'color: #4ade80; font-weight: 700; font-size: 16px;';
                pts.textContent = `${team.points || 0} pts`;

                row.appendChild(left);
                row.appendChild(pts);
                list.appendChild(row);
            });

            container.appendChild(list);
            document.body.appendChild(container);

            try {
                if (typeof html2canvas !== 'function') {
                    throw new Error('html2canvas library unavailable');
                }

                const canvas = await html2canvas(container, {
                    backgroundColor: '#0f172a',
                    scale: 2,
                    logging: false
                });

                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                if (!blob) throw new Error('Canvas blob generation failed');

                let copied = false;
                if (navigator.clipboard && window.ClipboardItem && navigator.clipboard.write) {
                    try {
                        const item = new ClipboardItem({ 'image/png': blob });
                        await navigator.clipboard.write([item]);
                        copied = true;
                        showToast('Leaderboard image copied to clipboard!', 'success');
                    } catch (clipErr) {
                        console.warn('ClipboardItem write failed, falling back to download:', clipErr);
                    }
                }

                if (!copied) {
                    const link = document.createElement('a');
                    link.download = `Leaderboard_Room_${currentRoomCode || 'Quiz'}.png`;
                    link.href = canvas.toDataURL('image/png');
                    link.click();
                    showToast('Image clipboard unsupported in browser. Downloaded PNG image!', 'info');
                }
            } finally {
                container.remove();
            }
        } catch (err) {
            console.error('Failed to copy leaderboard image:', err);
            showToast('Image clipboard is not supported in this browser.', 'error');
        }
    });
}

const btnCloseLeaderboard = document.getElementById('btn-close-leaderboard');
if (btnCloseLeaderboard) {
    btnCloseLeaderboard.addEventListener('click', () => {
        window.location.reload();
    });
}

// ----------------- Event Listeners (UI) -----------------

btnCreateRoom.addEventListener('click', () => {
    const sessionToken = getOrCreateSessionToken();
    socket.emit('create_room', { sessionToken });
});

inputRoomCode.addEventListener('input', () => {
    inputRoomCode.value = inputRoomCode.value.toUpperCase();
});

inputRoomCode.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnJoinRoom.click();
});

inputGroupName.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnJoinRoom.click();
});

btnJoinRoom.addEventListener('click', () => {
    const code = inputRoomCode.value.trim().toUpperCase();
    const name = inputGroupName.value.trim();

    if (!code || code.length !== 4) {
        showToast('Please enter a valid 4-letter room code', 'error');
        return;
    }
    if (!name) {
        showToast('Please enter your group name', 'error');
        return;
    }

    currentRoomCode = code;
    const sessionToken = getOrCreateSessionToken();
    socket.emit('join_room', { code, name, sessionToken });
});

buzzerBtn.addEventListener('click', () => {
    // FRONTEND LOCK PROTECTION: Block click if quiz is locked
    if (!isHost && isQuizLocked) {
        showToast('Quiz is locked due to tab/app switch violation!', 'error');
        lockQuizUI();
        return;
    }

    // Only buzz if it is active (not buzzed and buzzers allowed)
    if (buzzerBtn.classList.contains('active')) {
        // Mild single vibration pulse if supported on device
        if ('vibrate' in navigator) {
            try { navigator.vibrate(20); } catch (e) {}
        }

        // Optimistic UI update: Immediately transition to BUZZED (Sky Blue)
        setPlayerBuzzerState('buzzed');
        buzzerBtn.classList.add('pressed');
        setTimeout(() => buzzerBtn.classList.remove('pressed'), 150);

        socket.emit('buzz', currentRoomCode);
    }
});

btnResetBuzzers.addEventListener('click', () => {
    socket.emit('reset_buzzers', currentRoomCode);
    isBuzzerActive = false;
    if (btnToggleBuzzers) btnToggleBuzzers.textContent = 'Enable Buzzers';
});

if (btnToggleBuzzers) {
    btnToggleBuzzers.addEventListener('click', () => {
        isBuzzerActive = !isBuzzerActive;
        socket.emit('toggle_buzzers', { code: currentRoomCode, active: isBuzzerActive });
        btnToggleBuzzers.textContent = isBuzzerActive ? 'Disable Buzzers' : 'Enable Buzzers';
    });
}

if (btnEndQuiz) {
    btnEndQuiz.addEventListener('click', () => {
        const code = currentRoomCode || sessionStorage.getItem('quiz_room_code');
        if (!code) {
            showToast('No active room found', 'error');
            return;
        }
        if (endQuizModal) {
            endQuizModal.classList.remove('hidden');
        } else {
            socket.emit('toggle_buzzers', { code, active: false });
            socket.emit('room_closed_trigger', code);
        }
    });
}

if (btnConfirmEndQuiz) {
    btnConfirmEndQuiz.addEventListener('click', () => {
        const code = currentRoomCode || sessionStorage.getItem('quiz_room_code');
        if (endQuizModal) endQuizModal.classList.add('hidden');
        if (code) {
            socket.emit('toggle_buzzers', { code, active: false });
            socket.emit('room_closed_trigger', code);
        }
    });
}

if (btnCancelEndQuiz) {
    btnCancelEndQuiz.addEventListener('click', () => {
        if (endQuizModal) endQuizModal.classList.add('hidden');
    });
}

// Update points function
function updatePoints(targetSocketId, delta) {
    socket.emit('update_points', { code: currentRoomCode, targetSocketId, delta });
}

// Use touchstart for faster response on mobile
buzzerBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    buzzerBtn.click();
}, { passive: false });


if (btnWarningLeave) {
    btnWarningLeave.addEventListener('click', () => {
        window.location.reload();
    });
}

// ----------------- Socket.IO Listeners -----------------

socket.on('connect', () => {
    const token = sessionStorage.getItem('quiz_session_token');
    const savedRoom = sessionStorage.getItem('quiz_room_code') || currentRoomCode;
    if (token && savedRoom) {
        socket.emit('session_resume', { sessionToken: token });
    }
});

socket.on('session_restored', (data) => {
    if (!data) return;
    currentRoomCode = data.code;
    sessionStorage.setItem('quiz_room_code', data.code);

    if (data.role === 'host') {
        isHost = true;
        connectedTeams = data.connectedTeams || [];
        displayRoomCode.textContent = currentRoomCode;
        if (buzzesList) renderBuzzesList(data.buzzes || [], buzzesList);
        renderTeams();
        renderHostLeaderboard(connectedTeams);
        renderDisqualified(data.disqualified || []);
        if (requestsList) {
            renderRequestsList(data.pendingRequests || []);
        }
        if (btnToggleBuzzers) {
            btnToggleBuzzers.textContent = data.buzzesAllowed ? 'Disable Buzzers' : 'Enable Buzzers';
        }
        switchView('host');
        showToast('Host session restored', 'success');
    } else {
        isHost = false;
        currentGroupName = data.name;
        displayGroupName.textContent = currentGroupName;
        playerRoomCode.textContent = currentRoomCode;
        if (waitingModal) waitingModal.classList.add('hidden');

        if (data.isDisqualified) {
            if (disqualifiedModal) disqualifiedModal.classList.remove('hidden');
        } else if (data.isLocked) {
            lockQuizUI();
        } else {
            unlockQuizUI();
            if (data.buzzed) {
                setPlayerBuzzerState('buzzed');
            } else if (data.buzzesAllowed) {
                setPlayerBuzzerState('active');
            } else {
                setPlayerBuzzerState('disabled');
            }
        }
        switchView('player');
        showToast('Participant session restored', 'success');
    }
});

socket.on('session_invalid', () => {
    sessionStorage.removeItem('quiz_session_token');
    sessionStorage.removeItem('quiz_room_code');
    currentRoomCode = '';
    currentGroupName = '';
    switchView('home');
});

socket.on('session_expired', (data) => {
    sessionStorage.removeItem('quiz_session_token');
    sessionStorage.removeItem('quiz_room_code');
    currentRoomCode = '';
    currentGroupName = '';
    switchView('home');
    showToast(data && data.message ? data.message : 'Your quiz session has expired. Please rejoin the room.', 'error');
});

socket.on('disconnect', (reason) => {
    if (!isHost && currentRoomCode) {
        showToast('Connection lost. Reconnecting...', 'error');
        if (playerStatusText) {
            playerStatusText.textContent = 'Connection lost. Reconnecting...';
            playerStatusText.style.color = '#f59e0b';
        }
    }
});

socket.on('group_connection_status', (data) => {
    if (!isHost || !data) return;
    const team = connectedTeams.find(t => t.socketId === data.socketId || t.name === data.name);
    if (team) {
        team.disconnected = !data.connected;
        renderTeams();
    }
});

socket.on('error', (msg) => {
    showToast(msg, 'error');
    if (waitingModal) waitingModal.classList.add('hidden');
});

// HOST: Room created
socket.on('room_created', (data) => {
    isHost = true;
    const code = typeof data === 'object' ? data.code : data;
    const token = typeof data === 'object' ? data.sessionToken : null;
    if (token) sessionStorage.setItem('quiz_session_token', token);
    currentRoomCode = code;
    sessionStorage.setItem('quiz_room_code', code);

    connectedTeams = [];
    displayRoomCode.textContent = code;
    if (buzzesList) buzzesList.innerHTML = '<div class="empty-state large"><div class="icon-pulse">🔔</div><p>Waiting for buzzes...</p></div>';
    if (hostLeaderboardSummary) hostLeaderboardSummary.innerHTML = '<span class="empty-state">No teams yet</span>';
    if (disqualifiedList) disqualifiedList.innerHTML = '<li class="empty-state">None yet</li>';
    if (requestsList) requestsList.innerHTML = '<li class="empty-state">No pending requests</li>';
    renderTeams();
    switchView('host');
    showToast('Room created successfully', 'success');
});

// PLAYER: Waiting for approval
socket.on('waiting_for_approval', (data) => {
    if (data && data.sessionToken) sessionStorage.setItem('quiz_session_token', data.sessionToken);
    if (waitingModal) waitingModal.classList.remove('hidden');
});

// HOST: Join Request Received
socket.on('join_request', (data) => {
    if (!isHost) return;
    showToast(`New join request: ${data.name}`, 'info');
});

// HOST: Update Requests List
socket.on('requests_update', (requests) => {
    if (!isHost || !requestsList) return;
    renderRequestsList(requests);
});

function renderRequestsList(requests) {
    if (!requestsList) return;
    requestsList.innerHTML = '';
    if (requests.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty-state';
        li.textContent = 'No pending requests';
        requestsList.appendChild(li);
        return;
    }

    requests.forEach(req => {
        const li = document.createElement('li');
        li.className = 'team-item';
        li.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';

        const nameSpan = document.createElement('span');
        nameSpan.style.fontWeight = '600';
        nameSpan.textContent = req.name;

        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display:flex; gap:0.5rem;';

        const allowBtn = document.createElement('button');
        allowBtn.className = 'btn primary-btn';
        allowBtn.style.cssText = 'padding:0.4rem 0.8rem; font-size:0.8rem;';
        allowBtn.textContent = 'Allow';
        allowBtn.addEventListener('click', () => resolveJoin(req.socketId, 'allow'));

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'btn warning-btn';
        rejectBtn.style.cssText = 'padding:0.4rem 0.8rem; font-size:0.8rem;';
        rejectBtn.textContent = 'Reject';
        rejectBtn.addEventListener('click', () => resolveJoin(req.socketId, 'reject'));

        btnGroup.appendChild(allowBtn);
        btnGroup.appendChild(rejectBtn);

        li.appendChild(nameSpan);
        li.appendChild(btnGroup);

        requestsList.appendChild(li);
    });
}

function resolveJoin(targetSocketId, action) {
    socket.emit('resolve_join', { code: currentRoomCode, targetSocketId, action });
}

// PLAYER: Joined room successfully
socket.on('joined_room', (data) => {
    if (waitingModal) waitingModal.classList.add('hidden');
    currentRoomCode = data.code;
    currentGroupName = data.name;
    sessionStorage.setItem('quiz_room_code', data.code);

    displayGroupName.textContent = currentGroupName;
    playerRoomCode.textContent = currentRoomCode;

    if (data.buzzesAllowed) {
        setPlayerBuzzerState('active');
    } else {
        setPlayerBuzzerState('disabled');
    }

    switchView('player');
    isHost = false; // Explicitly ensure NOT a host on player join
    showToast('Joined Room!', 'success');
});

// PLAYER: Buzz response from server
socket.on('buzz_registered', (data) => {
    setPlayerBuzzerState('buzzed', data ? data.rank : null);
});

// PLAYER: Server-side Buzz Rejection (DevTools or UI bypass prevention)
socket.on('buzz_rejected', (data) => {
    showToast(data.message || 'Buzz rejected: Active violation pending!', 'error');
    lockQuizUI();
});

// EVERYONE: Buzzers active/inactive toggle
socket.on('buzzer_state', (data) => {
    isBuzzerActive = data.active;
    if (isHost && btnToggleBuzzers) {
        btnToggleBuzzers.textContent = data.active ? 'Disable Buzzers' : 'Enable Buzzers';
    } else if (!isHost) {
        if (data.active) setPlayerBuzzerState('active');
        else setPlayerBuzzerState('disabled');
    }
});

// EVERYONE: Points Leaderboard Update
socket.on('points_update', (teamsWithPoints) => {
    connectedTeams = teamsWithPoints; // Store for host
    if (isHost) {
        renderTeams();
        renderHostLeaderboard(teamsWithPoints);
    } else {
        // Participants don't see points anymore
    }
});

// PLAYER: Host reset buzzers
socket.on('reset', (data) => {
    if (data.buzzesAllowed) {
        setPlayerBuzzerState('active');
        showToast('Buzzers Reset! Get Ready.', 'info');
    } else {
        setPlayerBuzzerState('disabled');
        showToast('Buzzers Reset (OFF)', 'info');
    }
});

// HOST / PLAYER: Room closed with Final Results
socket.on('room_closed', (results) => {
    releaseImmersiveMode();
    sessionStorage.removeItem('quiz_room_code');
    console.log("Room closed received. results:", !!results, "isHost:", isHost);

    if (isHost && results && (results.teams || results.disqualified)) {
        console.log("I am Host - showing leaderboard modal.");
        lastGlobalResults = results;
        renderFinalLeaderboard(results);
    } else {
        console.log("I am Participant - hiding leaderboard and resetting.");
        if (leaderboardModal) leaderboardModal.classList.add('hidden');
        showToast('The Host has ended the quiz.', 'error');
        setTimeout(() => {
            sessionStorage.removeItem('quiz_session_token');
            window.location.reload();
        }, 3000);
    }
});

function renderFinalLeaderboard(results) {
    if (!leaderboardContainer || !leaderboardModal) return;

    leaderboardContainer.innerHTML = '';

    // Sort teams by points
    const sortedTeams = [...results.teams].sort((a, b) => b.points - a.points);

    let html = `
        <div style="margin-bottom: 2rem;">
            <p style="font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 0.5rem;">Room Code: <strong style="color:var(--primary-color)">${escapeHTML(results.code)}</strong></p>
            <p style="font-size: 0.9rem; color: var(--text-secondary);">Date: ${escapeHTML(new Date().toLocaleString())}</p>
        </div>
        
        <h4 style="margin-bottom: 1rem; color: var(--success); border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 0.5rem;">Final Standings</h4>
        <div style="display:flex; flex-direction:column; gap: 0.8rem; margin-bottom: 2rem;">
    `;

    sortedTeams.forEach((team, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`;
        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding: 1rem; border-radius: 8px;">
                <div style="display:flex; align-items:center; gap: 1rem;">
                    <span style="font-weight: 800; font-size: 1.2rem; min-width: 30px; color:var(--primary-color)">${medal}</span>
                    <span style="font-weight: 600;">${escapeHTML(team.name)}</span>
                </div>
                <span style="font-weight: 800; color: var(--success); font-size: 1.1rem;">${Number(team.points) || 0} pts</span>
            </div>
        `;
    });

    html += `</div>`;

    if (results.disqualified && results.disqualified.length > 0) {
        html += `
            <h4 style="margin-bottom: 1rem; color: var(--danger); border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 0.5rem;">Disqualified Teams</h4>
            <div style="display:flex; flex-wrap:wrap; gap: 0.5rem;">
        `;
        results.disqualified.forEach(name => {
            html += `<span style="background:rgba(239, 68, 68, 0.1); color:#ef4444; padding: 0.4rem 0.8rem; border-radius: 20px; font-size: 0.85rem; border: 1px solid rgba(239, 68, 68, 0.2);">❌ ${escapeHTML(name)}</span>`;
        });
        html += `</div>`;
    }

    leaderboardContainer.innerHTML = html;
    leaderboardModal.classList.remove('hidden');
}

if (btnDownloadPdf) {
    btnDownloadPdf.addEventListener('click', () => {
        if (!lastGlobalResults) return;
        generatePDF(lastGlobalResults);
    });
}

async function generatePDF(results) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
        showToast('PDF library not loaded. Please check your network connection.', 'error');
        return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // Header
    doc.setFillColor(30, 30, 30);
    doc.rect(0, 0, 210, 40, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(22);
    doc.text("QUIZ BUZZER - FINAL RESULTS", 105, 20, { align: "center" });

    doc.setTextColor(200, 200, 200);
    doc.setFontSize(12);
    doc.text(`Room: ${results.code} | Date: ${new Date().toLocaleString()}`, 105, 30, { align: "center" });

    // Standings
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.text("Final Standings", 20, 55);

    let y = 65;
    const sorted = [...results.teams].sort((a, b) => b.points - a.points);

    doc.setFontSize(12);
    doc.setFont(undefined, 'normal');

    sorted.forEach((team, index) => {
        if (y > 270) { doc.addPage(); y = 20; }

        // Background for odd rows
        if (index % 2 === 0) {
            doc.setFillColor(245, 245, 245);
            doc.rect(15, y - 5, 180, 10, 'F');
        }

        doc.text(`${index + 1}.`, 20, y);
        doc.text(team.name, 35, y);
        doc.text(`${team.points} Points`, 190, y, { align: "right" });
        y += 10;
    });

    // Disqualified
    if (results.disqualified && results.disqualified.length > 0) {
        y += 10;
        if (y > 270) { doc.addPage(); y = 20; }

        doc.setFont(undefined, 'bold');
        doc.setTextColor(239, 68, 68);
        doc.text("Disqualified Teams", 20, y);
        y += 10;

        doc.setFont(undefined, 'normal');
        doc.setTextColor(0, 0, 0);
        results.disqualified.forEach(name => {
            if (y > 270) { doc.addPage(); y = 20; }
            doc.text(`• ${name}`, 25, y);
            y += 7;
        });
    }

    // Footer
    doc.setFontSize(10);
    doc.setTextColor(150, 150, 150);
    doc.text("Generated by Quiz Buzzer App", 105, 285, { align: "center" });

    doc.save(`Quiz_Results_${results.code}.pdf`);
}

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

// EVERYONE: Buzz updates
socket.on('buzzes_update', (buzzes) => {
    renderBuzzesView(buzzes);
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

function renderDisqualified(disqualified) {
    if (!disqualifiedList) return;
    disqualifiedList.innerHTML = '';
    if (disqualified.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty-state';
        li.textContent = 'None yet';
        disqualifiedList.appendChild(li);
        return;
    }
    disqualified.forEach(name => {
        const li = document.createElement('li');
        li.className = 'team-item';
        li.style.cssText = 'background:rgba(239, 68, 68, 0.1); border-left: 3px solid #ef4444;';
        
        const span = document.createElement('span');
        span.style.color = '#ef4444';
        span.textContent = `❌ ${name}`;
        li.appendChild(span);
        disqualifiedList.appendChild(li);
    });
}

// ADVANCED ANTI-CHEATING MONITORING ENGINE & LOCK STATE MACHINE
let lastViolationTime = 0;
const VIOLATION_COOLDOWN_MS = 1500; // Deduplication cooldown window (1.5s)

function isFullscreenActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}

function releaseImmersiveMode() {
    try {
        if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
            document.mozCancelFullScreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    } catch (e) {}
}

function lockQuizUI() {
    if (isHost) return;
    isQuizLocked = true;
    if (buzzerBtn) {
        buzzerBtn.classList.add('disabled');
        buzzerBtn.classList.remove('active', 'pressed');
    }
    if (redWarningModal) redWarningModal.classList.remove('hidden');
    if (fullscreenLockStatus) {
        fullscreenLockStatus.innerHTML = 'Status: ⚠️ Tab/App Switch Detected (Quiz Locked)';
        fullscreenLockStatus.style.borderColor = 'rgba(239, 68, 68, 0.4)';
        fullscreenLockStatus.style.color = '#ef4444';
    }
}

function unlockQuizUI() {
    isQuizLocked = false;
    if (redWarningModal) redWarningModal.classList.add('hidden');
    if (fullscreenLockStatus) {
        fullscreenLockStatus.innerHTML = 'Status: 🔒 Active in Quiz';
        fullscreenLockStatus.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        fullscreenLockStatus.style.color = '#10b981';
    }
    if (isBuzzerActive) {
        setPlayerBuzzerState('active');
    }
}

function sendViolation(type, details = '') {
    if (isHost || !currentRoomCode) return;

    const now = Date.now();
    if (now - lastViolationTime < VIOLATION_COOLDOWN_MS) return;
    lastViolationTime = now;

    const fullscreen = isFullscreenActive();
    const visibilityState = document.visibilityState || 'visible';
    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

    lockQuizUI();

    socket.emit('tab_violation', {
        code: currentRoomCode,
        groupName: currentGroupName,
        type: type,
        fullscreen: fullscreen,
        visibilityState: visibilityState,
        hasFocus: hasFocus,
        details: details,
        timestamp: now
    });
}

// 1. Primary Anti-Cheat: Document Visibility Change Detection
document.addEventListener('visibilitychange', () => {
    if (!isHost && currentRoomCode && document.visibilityState === 'hidden') {
        lockQuizUI();
        sendViolation('TAB_SWITCH', 'Switched browser tab or minimized application');
    }
});

// 2. Window Blur (Keep for lifecycle tracking only; do NOT trigger cheating violations to prevent iPhone false positives)
window.addEventListener('blur', () => {
    // Weak focus signal: do NOT trigger cheating violation
});

// 3. Page Hide (Keep for lifecycle tracking only; do NOT trigger cheating violations to prevent iPhone false positives)
window.addEventListener('pagehide', () => {
    // Weak lifecycle signal: do NOT trigger cheating violation
});

// 4. Shortcut Blocking
document.addEventListener('keydown', (e) => {
    if (isHost) return;

    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
        e.preventDefault();
        return false;
    }
});

// Block Context Menu
document.addEventListener('contextmenu', (e) => {
    if (!isHost) e.preventDefault();
});

// 5. Periodic Lightweight Participant Heartbeat Loop (Every 4s)
setInterval(() => {
    if (!isHost && currentRoomCode && currentGroupName) {
        const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
        const isHidden = document.visibilityState === 'hidden';

        // ONLY actual visibilityState === 'hidden' triggers anti-cheat violation
        if (isHidden) {
            lockQuizUI();
            sendViolation('TAB_SWITCH', 'Heartbeat detected hidden tab');
        }

        socket.emit('participant_heartbeat', {
            code: currentRoomCode,
            groupName: currentGroupName,
            fullscreen: isFullscreenActive(),
            visibilityState: document.visibilityState || 'visible',
            hasFocus: hasFocus,
            timestamp: Date.now()
        });
    }
}, 4000);

// Participant Return to Quiz Button Handler
if (btnWarningStay) {
    btnWarningStay.addEventListener('click', () => {
        playerState = PLAYER_STATE.RESTORED;
        socket.emit('participant_returned', { code: currentRoomCode });
        unlockQuizUI();
        playerState = PLAYER_STATE.NORMAL;
        showToast('Returned to quiz! Quiz unlocked.', 'success');
    });
}

// Global Freeze Listener
socket.on('global_freeze', ({ violatorNames, pendingNames, manualFreeze }) => {
    if (isHost) return;
    if (globalFreezeText) {
        let msg = '';
        if (manualFreeze) {
            msg += `🔒 <strong style="color:var(--primary-color)">Room is manually frozen by Host</strong>.<br>`;
        }
        if (violatorNames && violatorNames.length > 0) {
            const names = violatorNames.map(n => escapeHTML(n)).join("', '");
            msg += `⚠️ <strong style="color:var(--danger)">Teams '${names}'</strong> triggered anti-cheating alerts!<br>`;
        }
        if (pendingNames && pendingNames.length > 0) {
            const names = pendingNames.map(n => escapeHTML(n)).join("', '");
            msg += `📨 <strong style="color:var(--secondary)">Teams '${names}'</strong> are requesting to join!<br>`;
        }

        if (!msg) msg = 'Page is frozen by Host.';

        globalFreezeText.innerHTML = msg;
    }
    if (freezeModal) freezeModal.classList.remove('hidden');
});

// Host: Rich Tab Violation Alerts Received
socket.on('tab_violation_alert', ({ violations }) => {
    if (!isHost) return;

    if (violatorListContainer) {
        violatorListContainer.innerHTML = '';
        if (!violations || violations.length === 0) {
            if (hostAlertModal) hostAlertModal.classList.add('hidden');
            return;
        }

        violations.forEach(v => {
            const rawName = typeof v === 'object' ? v.name : v;
            const vType = typeof v === 'object' && v.type ? v.type : 'TAB_SWITCH';
            const vTime = typeof v === 'object' && v.timeStr ? v.timeStr : '';
            const vDetails = typeof v === 'object' && v.details ? v.details : '';
            const vSocketId = typeof v === 'object' && v.socketId ? v.socketId : '';

            let badgeColor = '#ef4444';
            if (vType === 'SUSPICIOUS_SYSTEM_UI') badgeColor = '#f59e0b';
            else if (vType === 'HEARTBEAT_TIMEOUT') badgeColor = '#ec4899';

            const div = document.createElement('div');
            div.style.cssText = 'background:rgba(255,255,255,0.05); padding:1rem; border-radius:10px; margin-bottom:0.8rem; border:1px solid rgba(255,255,255,0.1); text-align:left;';

            const headerDiv = document.createElement('div');
            headerDiv.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;';

            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'font-weight:700; font-size:1.1rem; color:#fff;';
            nameSpan.textContent = `⚠️ ${rawName}`;

            const badgeSpan = document.createElement('span');
            badgeSpan.style.cssText = `background:${badgeColor}; color:#fff; font-size:0.7rem; font-weight:800; padding:0.2rem 0.5rem; border-radius:4px;`;
            badgeSpan.textContent = vType;

            headerDiv.appendChild(nameSpan);
            headerDiv.appendChild(badgeSpan);

            const detailsDiv = document.createElement('div');
            detailsDiv.style.cssText = 'font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.8rem;';
            
            const timeDiv = document.createElement('div');
            timeDiv.textContent = `Time: ${vTime}`;
            const textDiv = document.createElement('div');
            textDiv.textContent = vDetails;
            detailsDiv.appendChild(timeDiv);
            detailsDiv.appendChild(textDiv);

            const btnGroup = document.createElement('div');
            btnGroup.style.cssText = 'display:flex; gap:0.5rem; justify-content:flex-end;';

            const disqBtn = document.createElement('button');
            disqBtn.className = 'btn warning-btn';
            disqBtn.style.cssText = 'padding:0.4rem 0.8rem; font-size:0.8rem;';
            disqBtn.textContent = 'Disqualify';
            disqBtn.addEventListener('click', () => resolveTeam(vSocketId, 'disqualify'));

            const warnBtn = document.createElement('button');
            warnBtn.className = 'btn secondary-btn';
            warnBtn.style.cssText = 'padding:0.4rem 0.8rem; font-size:0.8rem; background:#f59e0b; color:#fff;';
            warnBtn.textContent = 'Warn';
            warnBtn.addEventListener('click', () => resolveTeam(vSocketId, 'warn'));

            const letgoBtn = document.createElement('button');
            letgoBtn.className = 'btn primary-btn';
            letgoBtn.style.cssText = 'padding:0.4rem 0.8rem; font-size:0.8rem;';
            letgoBtn.textContent = 'Let Go';
            letgoBtn.addEventListener('click', () => resolveTeam(vSocketId, 'letgo'));

            btnGroup.appendChild(disqBtn);
            btnGroup.appendChild(warnBtn);
            btnGroup.appendChild(letgoBtn);

            div.appendChild(headerDiv);
            div.appendChild(detailsDiv);
            div.appendChild(btnGroup);

            violatorListContainer.appendChild(div);
        });
    }

    if (hostAlertModal && violations && violations.length > 0) hostAlertModal.classList.remove('hidden');
});

// Host: Participant returned alert
socket.on('participant_returned_alert', (data) => {
    if (isHost && data && data.name) {
        showToast(`Team '${data.name}' returned to quiz.`, 'info');
    }
});

function resolveTeam(socketId, action) {
    socket.emit('resolve_violation', { code: currentRoomCode, targetSocketId: socketId, action });
}

// Host: Resolve UI updates
socket.on('violation_resolved', ({ action, targetSocketId }) => {
    if (isHost) {
        if (hostAlertModal) hostAlertModal.classList.add('hidden');
        return;
    }

    if (freezeModal) freezeModal.classList.add('hidden');
    if (redWarningModal) redWarningModal.classList.add('hidden');

    if (action === 'letgo') {
        showToast('Host resumed the quiz!', 'success');
    } else if (action === 'warn') {
        showToast('Host issued a warning!', 'warning');
    } else if (action === 'join_resolved') {
        showToast('Host resolved join requests!', 'success');
    } else if (action === 'manual_unfreeze') {
        showToast('Host unfrozen the room!', 'success');
    } else if (action === 'disqualify') {
        if (socket.id === targetSocketId) {
            if (disqualifiedModal) disqualifiedModal.classList.remove('hidden');
            releaseImmersiveMode();
        } else {
            showToast('A violator was disqualified. Quiz resumes.', 'warning');
        }
    }
});

// Host receives winner detected event
socket.on('winner_detected', (data) => {
    if (!isHost || !data) return;
    if (winnerPromptMsg && winnerPromptModal) {
        winnerPromptMsg.innerHTML = `Winner: <strong style="color:var(--primary-color)">${escapeHTML(data.winnerName)}</strong><br>Final Score: <strong style="color:var(--success)">${Number(data.topScore)} Points</strong>`;
        winnerPromptModal.classList.remove('hidden');
    }
});

if (btnApproveWinner) {
    btnApproveWinner.addEventListener('click', () => {
        socket.emit('approve_winner_message', { code: currentRoomCode });
        if (winnerPromptModal) winnerPromptModal.classList.add('hidden');
        if (isHost && lastGlobalResults) {
            renderFinalLeaderboard(lastGlobalResults);
        }
    });
}

if (btnRejectWinner) {
    btnRejectWinner.addEventListener('click', () => {
        socket.emit('reject_winner_message', { code: currentRoomCode });
        if (winnerPromptModal) winnerPromptModal.classList.add('hidden');
        if (isHost && lastGlobalResults) {
            renderFinalLeaderboard(lastGlobalResults);
        }
    });
}

// Winner Participant receives congratulations
socket.on('winner_congratulations', (data) => {
    if (isHost || !data) return;
    if (winnerCongratulationsScore && winnerCongratulationsModal) {
        winnerCongratulationsScore.textContent = `Final Score: ${Number(data.points)} Points`;
        winnerCongratulationsModal.classList.remove('hidden');
    }
});

const btnWinnerDownloadPdf = document.getElementById('btn-winner-download-pdf');
if (btnWinnerDownloadPdf) {
    btnWinnerDownloadPdf.addEventListener('click', () => {
        if (lastGlobalResults) {
            generatePDF(lastGlobalResults);
        } else {
            showToast('Generating PDF report...', 'info');
            setTimeout(() => {
                if (lastGlobalResults) generatePDF(lastGlobalResults);
                else showToast('Results data not ready', 'error');
            }, 300);
        }
    });
}

if (btnCloseWinnerModal) {
    btnCloseWinnerModal.addEventListener('click', () => {
        if (winnerCongratulationsModal) winnerCongratulationsModal.classList.add('hidden');
    });
}

// ----------------- Render Functions -----------------

function renderTeams() {
    teamsCount.textContent = connectedTeams.length;

    if (connectedTeams.length === 0) {
        teamsList.innerHTML = '';
        const emptyLi = document.createElement('li');
        emptyLi.className = 'empty-state';
        emptyLi.textContent = 'Waiting for players to join...';
        teamsList.appendChild(emptyLi);
        return;
    }

    teamsList.innerHTML = '';

    // Sort teams by points descending
    const sortedTeams = [...connectedTeams].sort((a, b) => (b.points || 0) - (a.points || 0));

    sortedTeams.forEach(team => {
        const li = document.createElement('li');
        const points = Number(team.points) || 0;

        const mainDiv = document.createElement('div');
        mainDiv.style.cssText = 'display:flex; justify-content:space-between; align-items:center; width:100%;';

        const leftDiv = document.createElement('div');
        leftDiv.style.cssText = 'display:flex; align-items:center; gap:0.5rem;';

        const disqBtn = document.createElement('button');
        disqBtn.className = 'btn warning-btn';
        disqBtn.style.cssText = 'padding:0.3rem 0.5rem; font-size:0.7rem; background:#ef4444;';
        disqBtn.textContent = '❌';
        disqBtn.addEventListener('click', () => {
            requestDisqualify(team.socketId, team.name);
        });

        const nameSpan = document.createElement('span');
        nameSpan.textContent = team.name;

        leftDiv.appendChild(disqBtn);
        leftDiv.appendChild(nameSpan);

        if (team.disconnected) {
            const statusBadge = document.createElement('span');
            statusBadge.style.cssText = 'background:#f59e0b; color:#fff; font-size:0.65rem; font-weight:700; padding:0.15rem 0.4rem; border-radius:4px; margin-left:0.2rem;';
            statusBadge.textContent = 'Reconnecting';
            leftDiv.appendChild(statusBadge);
        }

        const ptControls = document.createElement('div');
        ptControls.className = 'pt-controls';

        const btnMinus1 = document.createElement('button');
        btnMinus1.className = 'pt-btn';
        btnMinus1.textContent = '-';
        btnMinus1.addEventListener('click', () => updatePoints(team.socketId, -1));

        const scoreDiv = document.createElement('div');
        scoreDiv.className = 'pt-score';
        scoreDiv.textContent = String(points);

        const btnPlus10 = document.createElement('button');
        btnPlus10.className = 'quick-pt-btn';
        btnPlus10.innerHTML = '+10<br><span style="font-size:0.6rem;opacity:0.8;">(No pass)</span>';
        btnPlus10.addEventListener('click', () => updatePoints(team.socketId, 10));

        const btnPlus7 = document.createElement('button');
        btnPlus7.className = 'quick-pt-btn';
        btnPlus7.innerHTML = '+7<br><span style="font-size:0.6rem;opacity:0.8;">(1st pass)</span>';
        btnPlus7.addEventListener('click', () => updatePoints(team.socketId, 7));

        const btnPlus4 = document.createElement('button');
        btnPlus4.className = 'quick-pt-btn';
        btnPlus4.innerHTML = '+4<br><span style="font-size:0.6rem;opacity:0.8;">(Second pass)</span>';
        btnPlus4.addEventListener('click', () => updatePoints(team.socketId, 4));

        ptControls.appendChild(btnMinus1);
        ptControls.appendChild(scoreDiv);
        ptControls.appendChild(btnPlus10);
        ptControls.appendChild(btnPlus7);
        ptControls.appendChild(btnPlus4);

        mainDiv.appendChild(leftDiv);
        mainDiv.appendChild(ptControls);

        li.appendChild(mainDiv);
        teamsList.appendChild(li);
    });
}

// Host: Manual Disqualify Flow
function requestDisqualify(socketId, name) {
    pendingDisqualifySocketId = socketId;
    if (disqualifyMsg) {
        disqualifyMsg.textContent = `Are you sure you want to disqualify '${name}'?`;
    }

    // Freeze room while host decides
    socket.emit('toggle_manual_freeze', { code: currentRoomCode, freeze: true });

    if (hostConfirmModal) hostConfirmModal.classList.remove('hidden');
}

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

function renderBuzzesView(buzzes) {
    // Render for Host main list
    if (isHost) {
        renderBuzzesList(buzzes, buzzesList);
    } else {
        // Player view: check if player has buzzed and sync buzzed state
        const myBuzzIndex = buzzes.findIndex(b => b.socketId === socket.id);
        if (myBuzzIndex !== -1) {
            setPlayerBuzzerState('buzzed');
        }
        renderBuzzesList(buzzes, playerBuzzesList);
    }
}

function renderBuzzesList(buzzes, container) {
    if (!container) return;

    if (buzzes.length === 0) {
        container.innerHTML = `
            <div class="empty-state large">
                <div class="icon-pulse">🔔</div>
                <p>Waiting for buzzes...</p>
            </div>`;
        return;
    }

    container.innerHTML = '';
    buzzes.forEach((buzz, index) => {
        const li = document.createElement('li');
        li.className = 'buzz-item';
        if (index === 0) li.classList.add('first-place');

        let rankStr = `#${index + 1}`;

        li.innerHTML = `
            <span class="rank">${rankStr}</span>
            <span class="team-name" style="flex:1; margin-left:1rem;">${escapeHTML(buzz.name)}</span>
            <span class="time-diff" style="font-family:monospace; font-size:0.75rem; color:var(--primary-color); opacity:0.8;">${escapeHTML(buzz.timeStr)}</span>
        `;

        container.appendChild(li);
    });
}

function setPlayerBuzzerState(state, rank = null) {
    if (!buzzerBtn) return;

    const isPressed = buzzerBtn.classList.contains('pressed');
    buzzerBtn.className = 'buzzer-btn'; // reset
    if (isPressed) buzzerBtn.classList.add('pressed');

    if (state === 'active') {
        buzzerBtn.classList.add('active');
        if (buzzerText) buzzerText.textContent = 'BUZZ';
        if (playerStatusText) {
            playerStatusText.textContent = 'Buzzer is active! Tap as fast as you can.';
            playerStatusText.style.color = '#22c55e';
        }
    }
    else if (state === 'buzzed') {
        buzzerBtn.classList.add('buzzed');
        if (buzzerText) buzzerText.textContent = 'BUZZED';
        if (playerStatusText) {
            if (rank) {
                playerStatusText.textContent = `You buzzed in rank #${rank}`;
                playerStatusText.style.color = rank === 1 ? '#22c55e' : '#3b82f6';
            } else {
                playerStatusText.textContent = 'Buzzed!';
                playerStatusText.style.color = '#3b82f6';
            }
        }
    }
    else if (state === 'disabled') {
        buzzerBtn.classList.add('disabled');
        if (buzzerText) buzzerText.textContent = 'WAIT';
        if (playerStatusText) {
            playerStatusText.textContent = 'Waiting for host...';
            playerStatusText.style.color = 'var(--text-secondary)';
        }
    }
}

function renderHostLeaderboard(teamsWithPoints) {
    if (!hostLeaderboardSummary) return;

    if (teamsWithPoints.length === 0) {
        hostLeaderboardSummary.innerHTML = '';
        const emptySpan = document.createElement('span');
        emptySpan.className = 'empty-state';
        emptySpan.textContent = 'No teams yet';
        hostLeaderboardSummary.appendChild(emptySpan);
        return;
    }

    const sorted = [...teamsWithPoints].sort((a, b) => b.points - a.points);
    hostLeaderboardSummary.innerHTML = '';

    sorted.forEach(team => {
        const div = document.createElement('div');
        div.className = 'points-pill';

        const innerDiv = document.createElement('div');
        innerDiv.style.cssText = 'display:flex; justify-content:space-between; width:100%; align-items:center;';

        const nameSpan = document.createElement('span');
        nameSpan.style.fontWeight = '600';
        nameSpan.textContent = team.name;

        const scoreSpan = document.createElement('span');
        scoreSpan.className = 'score';
        scoreSpan.style.marginLeft = '1rem';
        scoreSpan.textContent = String(Number(team.points) || 0);

        innerDiv.appendChild(nameSpan);
        innerDiv.appendChild(scoreSpan);
        div.appendChild(innerDiv);

        hostLeaderboardSummary.appendChild(div);
    });
}

function renderPlayerPoints(teamsWithPoints) {
    // This is now disabled for players
}
