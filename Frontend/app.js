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
const btnCloseLeaderboard = document.getElementById('btn-close-leaderboard');

// Host Confirm Modal
const hostConfirmModal = document.getElementById('host-confirm-modal');
const disqualifyMsg = document.getElementById('disqualify-msg');
const btnConfirmDisqualify = document.getElementById('btn-confirm-disqualify');
const btnCancelDisqualify = document.getElementById('btn-cancel-disqualify');

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

// Session Identity Storage Helper
function saveSession(token, code, role, name) {
    try {
        localStorage.setItem('quiz_session', JSON.stringify({ token, code, role, name }));
    } catch (e) {}
}

function clearSession() {
    try {
        localStorage.removeItem('quiz_session');
    } catch (e) {}
}

function getSavedSession() {
    try {
        const raw = localStorage.getItem('quiz_session');
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

// Host Window Protection
window.addEventListener('beforeunload', (e) => {
    if (isHost && currentRoomCode) {
        e.preventDefault();
        e.returnValue = ''; // Standard way to show confirmation
        return 'Are you sure you want to end the quiz?';
    }
});

// ----------------- Helpers -----------------

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

// Global copy function for the room code
window.copyRoomCode = async () => {
    if (!currentRoomCode) return;
    try {
        await navigator.clipboard.writeText(currentRoomCode);
        showToast('Room Code copied to clipboard', 'success');
    } catch (err) {
        showToast('Failed to copy', 'error');
    }
};

if (displayRoomCode) {
    displayRoomCode.addEventListener('click', () => {
        window.copyRoomCode();
    });
}

if (btnCloseLeaderboard) {
    btnCloseLeaderboard.addEventListener('click', () => {
        clearSession();
        window.location.reload();
    });
}

// ----------------- Event Listeners (UI) -----------------

btnCreateRoom.addEventListener('click', () => {
    socket.emit('create_room');
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

    if (!code || code.length !== 6) {
        showToast('Please enter a valid 6-letter room code', 'error');
        return;
    }
    if (!name) {
        showToast('Please enter your group name', 'error');
        return;
    }

    currentRoomCode = code;
    socket.emit('join_room', { code, name });
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

// Global update points function for Host controls
window.updatePoints = (targetSocketId, delta) => {
    socket.emit('update_points', { code: currentRoomCode, targetSocketId, delta });
};

// Use touchstart for faster response on mobile
buzzerBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    buzzerBtn.click();
}, { passive: false });

if (btnWarningLeave) {
    btnWarningLeave.addEventListener('click', () => {
        clearSession();
        window.location.reload();
    });
}

// ----------------- Socket.IO & Session Listeners -----------------

// Auto-reconnect on socket connection using lightweight session token
socket.on('connect', () => {
    const saved = getSavedSession();
    if (saved && saved.token && saved.code) {
        socket.emit('session_resume', { token: saved.token, code: saved.code });
    }
});

socket.on('session_restored', (data) => {
    if (data.role === 'host') {
        isHost = true;
        currentRoomCode = data.code;
        connectedTeams = data.teams || [];
        displayRoomCode.textContent = data.code;
        renderTeams();
        if (data.buzzes) renderBuzzesView(data.buzzes);
        if (data.disqualified) renderDisqualified(data.disqualified);
        switchView('host');
        showToast('Host session restored!', 'success');
    } else if (data.role === 'participant') {
        isHost = false;
        currentRoomCode = data.code;
        currentGroupName = data.name;
        displayGroupName.textContent = currentGroupName;
        playerRoomCode.textContent = currentRoomCode;

        if (data.buzzesAllowed) setPlayerBuzzerState('active');
        else setPlayerBuzzerState('disabled');

        if (data.buzzes) renderBuzzesView(data.buzzes);
        switchView('player');
        showToast('Player session restored!', 'success');
    }
});

socket.on('session_invalid', () => {
    clearSession();
});

socket.on('error', (msg) => {
    showToast(msg, 'error');
    if (waitingModal) waitingModal.classList.add('hidden');
});

// Wake Lock Helper
window.requestFullScreen = async function () {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (e) {
        console.log("Wake lock error:", e);
    }
}

async function releaseImmersiveMode() {
    try {
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
            socket.emit('room_closed_trigger', currentRoomCode);
            clearSession();
        }
    });
}

// HOST: Copy Leaderboard Image
if (btnCopyLeaderboard) {
    btnCopyLeaderboard.addEventListener('click', async () => {
        if (connectedTeams.length === 0) return;

        // Temporarily create a hidden container for the snapshot
        const snapshotContainer = document.createElement('div');
        snapshotContainer.style.position = 'fixed';
        snapshotContainer.style.left = '-9999px';
        snapshotContainer.style.top = '0';
        snapshotContainer.style.background = '#0f172a';
        snapshotContainer.style.color = 'white';
        snapshotContainer.style.padding = '40px';
        snapshotContainer.style.width = 'fit-content';
        snapshotContainer.style.fontFamily = 'Inter, sans-serif';

        const title = document.createElement('h1');
        title.textContent = `Leaderboard - Room ${currentRoomCode}`;
        title.style.textAlign = 'center';
        title.style.marginBottom = '30px';
        title.style.color = '#38bdf8';
        snapshotContainer.appendChild(title);

        const listContainer = document.createElement('div');
        listContainer.style.display = 'flex';
        listContainer.style.gap = '40px';

        const sorted = [...connectedTeams].sort((a, b) => b.points - a.points);

        if (sorted.length > 25) {
            // Two columns
            const leftCol = document.createElement('div');
            const rightCol = document.createElement('div');
            leftCol.style.minWidth = '250px';
            rightCol.style.minWidth = '250px';

            sorted.slice(0, 25).forEach((team, i) => addTeamToSnapshot(leftCol, team, i + 1));
            sorted.slice(25).forEach((team, i) => addTeamToSnapshot(rightCol, team, i + 26));

            listContainer.appendChild(leftCol);
            listContainer.appendChild(rightCol);
        } else {
            // Single column
            const col = document.createElement('div');
            col.style.minWidth = '300px';
            sorted.forEach((team, i) => addTeamToSnapshot(col, team, i + 1));
            listContainer.appendChild(col);
        }

        snapshotContainer.appendChild(listContainer);
        document.body.appendChild(snapshotContainer);

        try {
            const canvas = await html2canvas(snapshotContainer);
            canvas.toBlob(async blob => {
                try {
                    if (navigator.clipboard && window.ClipboardItem) {
                        const item = new ClipboardItem({ "image/png": blob });
                        await navigator.clipboard.write([item]);
                        showToast('Leaderboard image copied to clipboard!', 'success');
                    } else {
                        showToast('Clipboard copy not supported in this browser', 'error');
                    }
                } catch (clipErr) {
                    console.error('Clipboard write failed:', clipErr);
                    showToast('Failed to copy image to clipboard.', 'error');
                }
            });
        } catch (err) {
            console.error('Snapshot failed:', err);
            showToast('Failed to copy image.', 'error');
        } finally {
            document.body.removeChild(snapshotContainer);
        }
    });
}

function addTeamToSnapshot(parent, team, rank) {
    const item = document.createElement('div');
    item.style.display = 'flex';
    item.style.justifyContent = 'space-between';
    item.style.padding = '8px 12px';
    item.style.marginBottom = '6px';
    item.style.background = 'rgba(255,255,255,0.05)';
    item.style.borderRadius = '6px';
    item.style.fontSize = '14px';

    const rankSpan = document.createElement('span');
    const rankStrong = document.createElement('strong');
    rankStrong.style.color = '#38bdf8';
    rankStrong.style.marginRight = '10px';
    rankStrong.textContent = `#${rank}`;
    rankSpan.appendChild(rankStrong);
    rankSpan.append(team.name);

    const ptsSpan = document.createElement('span');
    ptsSpan.style.fontWeight = '700';
    ptsSpan.style.color = '#4ade80';
    ptsSpan.textContent = `${Number(team.points) || 0} pts`;

    item.appendChild(rankSpan);
    item.appendChild(ptsSpan);
    parent.appendChild(item);
}

// HOST: Room created
socket.on('room_created', (data) => {
    isHost = true;
    const code = typeof data === 'object' ? data.code : data;
    const token = typeof data === 'object' ? data.sessionToken : null;
    currentRoomCode = code;

    if (token) saveSession(token, code, 'host', 'Host');

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
socket.on('waiting_for_approval', () => {
    if (waitingModal) waitingModal.classList.remove('hidden');
});

// HOST: Join Request Received
socket.on('join_request', (data) => {
    if (!isHost) return;
    showToast(`New join request: ${data.name}`, 'info');
});

// HOST: Update Requests List (Strict DOM manipulation - No inline event handlers)
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
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';

        const nameSpan = document.createElement('span');
        nameSpan.style.fontWeight = '600';
        nameSpan.textContent = req.name;

        const btnDiv = document.createElement('div');
        btnDiv.style.display = 'flex';
        btnDiv.style.gap = '0.5rem';

        const allowBtn = document.createElement('button');
        allowBtn.className = 'btn primary-btn';
        allowBtn.style.padding = '0.4rem 0.8rem';
        allowBtn.style.fontSize = '0.8rem';
        allowBtn.textContent = 'Allow';
        allowBtn.addEventListener('click', () => {
            resolveJoin(req.socketId, 'allow');
        });

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'btn warning-btn';
        rejectBtn.style.padding = '0.4rem 0.8rem';
        rejectBtn.style.fontSize = '0.8rem';
        rejectBtn.textContent = 'Reject';
        rejectBtn.addEventListener('click', () => {
            resolveJoin(req.socketId, 'reject');
        });

        btnDiv.appendChild(allowBtn);
        btnDiv.appendChild(rejectBtn);
        li.appendChild(nameSpan);
        li.appendChild(btnDiv);
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

    if (data.sessionToken) saveSession(data.sessionToken, data.code, 'participant', data.name);

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
    setPlayerBuzzerState('buzzed', data.rank);
});

// PLAYER: Server-side Buzz Rejection
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
    connectedTeams = teamsWithPoints;
    if (isHost) {
        renderTeams();
        renderHostLeaderboard(teamsWithPoints);
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
    clearSession();

    if (isHost && results && (results.teams || results.disqualified)) {
        lastGlobalResults = results;
        renderFinalLeaderboard(results);
    } else {
        if (leaderboardModal) leaderboardModal.classList.add('hidden');
        showToast('The Host has ended the quiz.', 'error');
        setTimeout(() => {
            window.location.reload();
        }, 3000);
    }
});

function renderFinalLeaderboard(results) {
    if (!leaderboardContainer || !leaderboardModal) return;

    leaderboardContainer.innerHTML = '';

    const infoDiv = document.createElement('div');
    infoDiv.style.marginBottom = '2rem';

    const roomP = document.createElement('p');
    roomP.style.fontSize = '1.1rem';
    roomP.style.color = 'var(--text-secondary)';
    roomP.style.marginBottom = '0.5rem';
    roomP.append('Room Code: ');
    const codeStrong = document.createElement('strong');
    codeStrong.style.color = 'var(--primary-color)';
    codeStrong.textContent = results.code;
    roomP.append(codeStrong);

    const dateP = document.createElement('p');
    dateP.style.fontSize = '0.9rem';
    dateP.style.color = 'var(--text-secondary)';
    dateP.textContent = `Date: ${new Date().toLocaleString()}`;

    infoDiv.appendChild(roomP);
    infoDiv.appendChild(dateP);

    const standingsHeader = document.createElement('h4');
    standingsHeader.style.marginBottom = '1rem';
    standingsHeader.style.color = 'var(--success)';
    standingsHeader.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
    standingsHeader.style.paddingBottom = '0.5rem';
    standingsHeader.textContent = 'Final Standings';

    const standingsContainer = document.createElement('div');
    standingsContainer.style.display = 'flex';
    standingsContainer.style.flexDirection = 'column';
    standingsContainer.style.gap = '0.8rem';
    standingsContainer.style.marginBottom = '2rem';

    const sortedTeams = [...results.teams].sort((a, b) => b.points - a.points);
    sortedTeams.forEach((team, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`;
        const itemDiv = document.createElement('div');
        itemDiv.style.display = 'flex';
        itemDiv.style.justifyContent = 'space-between';
        itemDiv.style.alignItems = 'center';
        itemDiv.style.background = 'rgba(255,255,255,0.05)';
        itemDiv.style.padding = '1rem';
        itemDiv.style.borderRadius = '8px';

        const left = document.createElement('div');
        left.style.display = 'flex';
        left.style.alignItems = 'center';
        left.style.gap = '1rem';

        const medalSpan = document.createElement('span');
        medalSpan.style.fontWeight = '800';
        medalSpan.style.fontSize = '1.2rem';
        medalSpan.style.minWidth = '30px';
        medalSpan.style.color = 'var(--primary-color)';
        medalSpan.textContent = medal;

        const nameSpan = document.createElement('span');
        nameSpan.style.fontWeight = '600';
        nameSpan.textContent = team.name;

        left.appendChild(medalSpan);
        left.appendChild(nameSpan);

        const pointsSpan = document.createElement('span');
        pointsSpan.style.fontWeight = '800';
        pointsSpan.style.color = 'var(--success)';
        pointsSpan.style.fontSize = '1.1rem';
        pointsSpan.textContent = `${Number(team.points) || 0} pts`;

        itemDiv.appendChild(left);
        itemDiv.appendChild(pointsSpan);
        standingsContainer.appendChild(itemDiv);
    });

    leaderboardContainer.appendChild(infoDiv);
    leaderboardContainer.appendChild(standingsHeader);
    leaderboardContainer.appendChild(standingsContainer);

    if (results.disqualified && results.disqualified.length > 0) {
        const disqHeader = document.createElement('h4');
        disqHeader.style.marginBottom = '1rem';
        disqHeader.style.color = 'var(--danger)';
        disqHeader.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
        disqHeader.style.paddingBottom = '0.5rem';
        disqHeader.textContent = 'Disqualified Teams';

        const disqContainer = document.createElement('div');
        disqContainer.style.display = 'flex';
        disqContainer.style.flexWrap = 'wrap';
        disqContainer.style.gap = '0.5rem';

        results.disqualified.forEach(name => {
            const span = document.createElement('span');
            span.style.background = 'rgba(239, 68, 68, 0.1)';
            span.style.color = '#ef4444';
            span.style.padding = '0.4rem 0.8rem';
            span.style.borderRadius = '20px';
            span.style.fontSize = '0.85rem';
            span.style.border = '1px solid rgba(239, 68, 68, 0.2)';
            span.textContent = `❌ ${name}`;
            disqContainer.appendChild(span);
        });

        leaderboardContainer.appendChild(disqHeader);
        leaderboardContainer.appendChild(disqContainer);
    }

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

    doc.setFillColor(30, 30, 30);
    doc.rect(0, 0, 210, 40, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(22);
    doc.text("QUIZ BUZZER - FINAL RESULTS", 105, 20, { align: "center" });

    doc.setTextColor(200, 200, 200);
    doc.setFontSize(12);
    doc.text(`Room: ${results.code} | Date: ${new Date().toLocaleString()}`, 105, 30, { align: "center" });

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

        if (index % 2 === 0) {
            doc.setFillColor(245, 245, 245);
            doc.rect(15, y - 5, 180, 10, 'F');
        }

        doc.text(`${index + 1}.`, 20, y);
        doc.text(team.name, 35, y);
        doc.text(`${team.points} Points`, 190, y, { align: "right" });
        y += 10;
    });

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

    doc.setFontSize(10);
    doc.setTextColor(150, 150, 150);
    doc.text("Generated by Quiz Buzzer App", 105, 285, { align: "center" });

    doc.save(`Quiz_Results_${results.code}.pdf`);
}

// HOST: New group joined
let connectedTeams = [];
socket.on('group_joined', (data) => {
    if (!isHost) return;

    const existingIdx = connectedTeams.findIndex(t => t.socketId === data.socketId);
    if (existingIdx !== -1) {
        connectedTeams[existingIdx] = data;
    } else {
        connectedTeams.push(data);
    }

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
        disqualifiedList.innerHTML = '<li class="empty-state">None yet</li>';
        return;
    }
    disqualified.forEach(name => {
        const li = document.createElement('li');
        li.className = 'team-item';
        li.style.background = 'rgba(239, 68, 68, 0.1)';
        li.style.borderLeft = '3px solid #ef4444';

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

// 1. Visibility Change Detection
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        lockQuizUI();
        sendViolation('TAB_SWITCH', 'Switched browser tab or minimized application');
    }
});

// 2. Window Blur / System UI Detection
window.addEventListener('blur', () => {
    if (isHost || !currentRoomCode) return;
    lockQuizUI();
    const isVisible = document.visibilityState === 'visible';
    if (isVisible) {
        sendViolation('SUSPICIOUS_SYSTEM_UI', 'Window lost focus while page remained visible (notification panel or app overlay)');
    } else {
        sendViolation('WINDOW_BLUR', 'Window lost focus');
    }
});

// 3. Page Hide Detection
window.addEventListener('pagehide', () => {
    lockQuizUI();
    sendViolation('PAGE_HIDDEN', 'Page hidden or browser context changed');
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
        socket.emit('participant_heartbeat', {
            code: currentRoomCode,
            groupName: currentGroupName,
            fullscreen: isFullscreenActive(),
            visibilityState: document.visibilityState || 'visible',
            hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
            timestamp: Date.now()
        });
    }
}, 4000);

// Participant Return to Game Button Handler
if (btnWarningStay) {
    btnWarningStay.addEventListener('click', () => {
        playerState = PLAYER_STATE.RESTORED;
        socket.emit('participant_returned', { code: currentRoomCode });
        unlockQuizUI();
        playerState = PLAYER_STATE.NORMAL;
        showToast('Returned to game! Quiz unlocked.', 'success');
    });
}

// Global Freeze Listener
socket.on('global_freeze', ({ violatorNames, pendingNames, manualFreeze }) => {
    if (isHost) return;
    if (globalFreezeText) {
        globalFreezeText.textContent = '';

        if (manualFreeze) {
            const p1 = document.createElement('p');
            p1.append('🔒 ');
            const s1 = document.createElement('strong');
            s1.style.color = 'var(--primary-color)';
            s1.textContent = 'Room is manually frozen by Host';
            p1.append(s1, '.');
            globalFreezeText.appendChild(p1);
        }
        if (violatorNames && violatorNames.length > 0) {
            const p2 = document.createElement('p');
            p2.append('⚠️ ');
            const s2 = document.createElement('strong');
            s2.style.color = 'var(--danger)';
            s2.textContent = `Teams '${violatorNames.join("', '")}'`;
            p2.append(s2, ' triggered anti-cheating alerts!');
            globalFreezeText.appendChild(p2);
        }
        if (pendingNames && pendingNames.length > 0) {
            const p3 = document.createElement('p');
            p3.append('📨 ');
            const s3 = document.createElement('strong');
            s3.style.color = 'var(--secondary)';
            s3.textContent = `Teams '${pendingNames.join("', '")}'`;
            p3.append(s3, ' are requesting to join!');
            globalFreezeText.appendChild(p3);
        }

        if (!globalFreezeText.childNodes.length) {
            globalFreezeText.textContent = 'Page is frozen by Host.';
        }
    }
    if (freezeModal) freezeModal.classList.remove('hidden');
});

// Host: Rich Tab Violation Alerts Received (Strict DOM construction)
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
            div.style.background = 'rgba(255,255,255,0.05)';
            div.style.padding = '1rem';
            div.style.borderRadius = '10px';
            div.style.marginBottom = '0.8rem';
            div.style.border = '1px solid rgba(255,255,255,0.1)';
            div.style.textAlign = 'left';

            const headerDiv = document.createElement('div');
            headerDiv.style.display = 'flex';
            headerDiv.style.justifyContent = 'space-between';
            headerDiv.style.alignItems = 'center';
            headerDiv.style.marginBottom = '0.4rem';

            const nameSpan = document.createElement('span');
            nameSpan.style.fontWeight = '700';
            nameSpan.style.fontSize = '1.1rem';
            nameSpan.style.color = '#fff';
            nameSpan.textContent = `⚠️ ${rawName}`;

            const badgeSpan = document.createElement('span');
            badgeSpan.style.background = badgeColor;
            badgeSpan.style.color = '#fff';
            badgeSpan.style.fontSize = '0.7rem';
            badgeSpan.style.fontWeight = '800';
            badgeSpan.style.padding = '0.2rem 0.5rem';
            badgeSpan.style.borderRadius = '4px';
            badgeSpan.textContent = vType;

            headerDiv.appendChild(nameSpan);
            headerDiv.appendChild(badgeSpan);

            const detailsDiv = document.createElement('div');
            detailsDiv.style.fontSize = '0.8rem';
            detailsDiv.style.color = 'var(--text-secondary)';
            detailsDiv.style.marginBottom = '0.8rem';

            const timeDiv = document.createElement('div');
            timeDiv.textContent = `Time: ${vTime}`;
            const detailsTextDiv = document.createElement('div');
            detailsTextDiv.textContent = vDetails;

            detailsDiv.appendChild(timeDiv);
            detailsDiv.appendChild(detailsTextDiv);

            const actionContainer = document.createElement('div');
            actionContainer.style.display = 'flex';
            actionContainer.style.gap = '0.5rem';
            actionContainer.style.justifyContent = 'flex-end';

            const disqBtn = document.createElement('button');
            disqBtn.className = 'btn warning-btn';
            disqBtn.style.padding = '0.4rem 0.8rem';
            disqBtn.style.fontSize = '0.8rem';
            disqBtn.textContent = 'Disqualify';
            disqBtn.addEventListener('click', () => resolveTeam(vSocketId, 'disqualify'));

            const warnBtn = document.createElement('button');
            warnBtn.className = 'btn secondary-btn';
            warnBtn.style.padding = '0.4rem 0.8rem';
            warnBtn.style.fontSize = '0.8rem';
            warnBtn.style.background = '#f59e0b';
            warnBtn.style.color = '#fff';
            warnBtn.textContent = 'Warn';
            warnBtn.addEventListener('click', () => resolveTeam(vSocketId, 'warn'));

            const letGoBtn = document.createElement('button');
            letGoBtn.className = 'btn primary-btn';
            letGoBtn.style.padding = '0.4rem 0.8rem';
            letGoBtn.style.fontSize = '0.8rem';
            letGoBtn.textContent = 'Let Go';
            letGoBtn.addEventListener('click', () => resolveTeam(vSocketId, 'letgo'));

            actionContainer.appendChild(disqBtn);
            actionContainer.appendChild(warnBtn);
            actionContainer.appendChild(letGoBtn);

            div.appendChild(headerDiv);
            div.appendChild(detailsDiv);
            div.appendChild(actionContainer);

            violatorListContainer.appendChild(div);
        });
    }

    if (hostAlertModal && violations && violations.length > 0) hostAlertModal.classList.remove('hidden');
});

// Host: Participant returned alert
socket.on('participant_returned_alert', (data) => {
    if (isHost && data && data.name) {
        showToast(`Team '${data.name}' returned to game.`, 'info');
    }
});

// Global resolution helper for host
window.resolveTeam = (socketId, action) => {
    socket.emit('resolve_violation', { code: currentRoomCode, targetSocketId: socketId, action });
};

// Host: Resolve UI updates
socket.on('violation_resolved', ({ action, targetSocketId }) => {
    if (isHost) {
        if (hostAlertModal) hostAlertModal.classList.add('hidden');
        return;
    }

    if (freezeModal) freezeModal.classList.add('hidden');
    if (redWarningModal) redWarningModal.classList.add('hidden');

    if (action === 'letgo') {
        showToast('Host resumed the game!', 'success');
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
            clearSession();
        } else {
            showToast('A violator was disqualified. Game resumes.', 'warning');
        }
    }
});

// ----------------- Render Functions (DOM API Standard) -----------------

function renderTeams() {
    teamsCount.textContent = connectedTeams.length;

    if (connectedTeams.length === 0) {
        teamsList.innerHTML = `<li class="empty-state">Waiting for players to join...</li>`;
        return;
    }

    teamsList.innerHTML = '';

    const sortedTeams = [...connectedTeams].sort((a, b) => (b.points || 0) - (a.points || 0));

    sortedTeams.forEach(team => {
        const li = document.createElement('li');

        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.justifyContent = 'space-between';
        wrapper.style.alignItems = 'center';
        wrapper.style.width = '100%';

        const leftGroup = document.createElement('div');
        leftGroup.style.display = 'flex';
        leftGroup.style.alignItems = 'center';
        leftGroup.style.gap = '0.5rem';

        const disqBtn = document.createElement('button');
        disqBtn.className = 'btn warning-btn';
        disqBtn.style.padding = '0.3rem 0.5rem';
        disqBtn.style.fontSize = '0.7rem';
        disqBtn.style.background = '#ef4444';
        disqBtn.textContent = '❌';
        disqBtn.addEventListener('click', () => {
            requestDisqualify(team.socketId, team.name);
        });

        const nameSpan = document.createElement('span');
        nameSpan.textContent = team.name;

        leftGroup.appendChild(disqBtn);
        leftGroup.appendChild(nameSpan);

        const ctrlGroup = document.createElement('div');
        ctrlGroup.className = 'pt-controls';

        const minusBtn = document.createElement('button');
        minusBtn.className = 'pt-btn';
        minusBtn.textContent = '-';
        minusBtn.addEventListener('click', () => updatePoints(team.socketId, -1));

        const scoreDiv = document.createElement('div');
        scoreDiv.className = 'pt-score';
        scoreDiv.textContent = Number(team.points) || 0;

        const add10Btn = document.createElement('button');
        add10Btn.className = 'quick-pt-btn';
        add10Btn.innerHTML = `+10<br><span style="font-size:0.6rem;opacity:0.8;">(No pass)</span>`;
        add10Btn.addEventListener('click', () => updatePoints(team.socketId, 10));

        const add7Btn = document.createElement('button');
        add7Btn.className = 'quick-pt-btn';
        add7Btn.innerHTML = `+7<br><span style="font-size:0.6rem;opacity:0.8;">(1st pass)</span>`;
        add7Btn.addEventListener('click', () => updatePoints(team.socketId, 7));

        const add4Btn = document.createElement('button');
        add4Btn.className = 'quick-pt-btn';
        add4Btn.innerHTML = `+4<br><span style="font-size:0.6rem;opacity:0.8;">(Second pass)</span>`;
        add4Btn.addEventListener('click', () => updatePoints(team.socketId, 4));

        ctrlGroup.appendChild(minusBtn);
        ctrlGroup.appendChild(scoreDiv);
        ctrlGroup.appendChild(add10Btn);
        ctrlGroup.appendChild(add7Btn);
        ctrlGroup.appendChild(add4Btn);

        wrapper.appendChild(leftGroup);
        wrapper.appendChild(ctrlGroup);
        li.appendChild(wrapper);

        teamsList.appendChild(li);
    });
}

// Host: Manual Disqualify Flow
window.requestDisqualify = (socketId, name) => {
    pendingDisqualifySocketId = socketId;
    if (disqualifyMsg) {
        disqualifyMsg.textContent = '';
        disqualifyMsg.append('Are you sure you want to disqualify ');
        const strong = document.createElement('strong');
        strong.textContent = `'${name}'`;
        disqualifyMsg.append(strong, '?');
    }

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

function renderBuzzesView(buzzes) {
    if (isHost) {
        renderBuzzesList(buzzes, buzzesList);
    } else {
        const myBuzzIndex = buzzes.findIndex(b => b.socketId === socket.id);
        if (myBuzzIndex !== -1) {
            setPlayerBuzzerState('buzzed', myBuzzIndex + 1);
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

        const rankSpan = document.createElement('span');
        rankSpan.className = 'rank';
        rankSpan.textContent = `#${index + 1}`;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'team-name';
        nameSpan.style.flex = '1';
        nameSpan.style.marginLeft = '1rem';
        nameSpan.textContent = buzz.name;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'time-diff';
        timeSpan.style.fontFamily = 'monospace';
        timeSpan.style.fontSize = '0.75rem';
        timeSpan.style.color = 'var(--primary-color)';
        timeSpan.style.opacity = '0.8';
        timeSpan.textContent = buzz.timeStr || '';

        li.appendChild(rankSpan);
        li.appendChild(nameSpan);
        li.appendChild(timeSpan);
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
                playerStatusText.textContent = 'Buzzed! Ranking...';
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
        hostLeaderboardSummary.innerHTML = `<span class="empty-state">No teams yet</span>`;
        return;
    }

    const sorted = [...teamsWithPoints].sort((a, b) => b.points - a.points);
    hostLeaderboardSummary.innerHTML = '';

    sorted.forEach(team => {
        const div = document.createElement('div');
        div.className = 'points-pill';

        const innerDiv = document.createElement('div');
        innerDiv.style.display = 'flex';
        innerDiv.style.justifyContent = 'space-between';
        innerDiv.style.width = '100%';
        innerDiv.style.alignItems = 'center';

        const nameSpan = document.createElement('span');
        nameSpan.style.fontWeight = '600';
        nameSpan.textContent = team.name;

        const scoreSpan = document.createElement('span');
        scoreSpan.className = 'score';
        scoreSpan.style.marginLeft = '1rem';
        scoreSpan.textContent = Number(team.points) || 0;

        innerDiv.appendChild(nameSpan);
        innerDiv.appendChild(scoreSpan);
        div.appendChild(innerDiv);
        hostLeaderboardSummary.appendChild(div);
    });
}
