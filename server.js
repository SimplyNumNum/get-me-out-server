const WebSocket = require('ws');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');

// ---------------------------------------------------------------------------
// Game data — mirrors the GDScript constants so the server can validate/roll
// ---------------------------------------------------------------------------

const SKIN_PACKS = {
    animatronics: { skins: [
        { id: 'ghost',     rarity: 'common' },
        { id: 'bear',      rarity: 'common' },
        { id: 'dino',      rarity: 'uncommon' },
        { id: 'speder',    rarity: 'rare' },
        { id: 'the_brain', rarity: 'epic' },
        { id: 'mimqu',     rarity: 'legendary' },
    ]},
    fantasy: { skins: [
        { id: 'knightskin', rarity: 'common' },
        { id: 'wizard',     rarity: 'common' },
        { id: 'rouge',      rarity: 'uncommon' },
        { id: 'preist',     rarity: 'rare' },
        { id: 'cultist',    rarity: 'epic' },
        { id: 'raveger',    rarity: 'legendary' },
    ]},
};

const TOOL_PACKS = {
    tools: { items: [
        { id: 'brighter_lights', rarity: 'common' },
        { id: 'running_shoes',   rarity: 'common' },
        { id: 'power_boost',     rarity: 'uncommon' },
        { id: 'power_savor',     rarity: 'rare' },
        { id: 'high_roller',     rarity: 'epic' },
        { id: 'get_it_out',      rarity: 'legendary' },
    ]},
};

const CLASS_PACKS = {
    classes: { items: [
        { id: 'janitor',        rarity: 'common' },
        { id: 'electrician',    rarity: 'common' },
        { id: 'runner',         rarity: 'uncommon' },
        { id: 'reaching',       rarity: 'rare' },
        { id: 'security_guard', rarity: 'epic' },
        { id: 'sparks',         rarity: 'legendary' },
    ]},
};

const RARITY_POOL      = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 };
const RARITY_REFUND    = { common: 2,  uncommon: 5,  rare: 7,  epic: 10, legendary: 14 };
const ROLL_COST        = { 1: 10, 10: 75 };    // skin machine costs
const TOOL_ROLL_COST   = { 1: 15, 10: 95 };    // tool machine costs
const CLASS_ROLL_COST  = { 1: 20, 10: 120 };   // class machine costs

// Skins that are unlocked via achievement rewards (not pack rolls)
const ACHIEVEMENT_SKINS = new Set(['banana']);
// Owner-only skins: skin_id → required username
const OWNER_SKINS = { numnun: 'SimplyNumNum' };

// Achievement rewards — validated server-side
const ACHIEVEMENT_REWARDS = {
    complete_tutorial: { sparks: 10 },   // 10 sparks + 25 XP (XP applied automatically for all achievements)
    survive_night_5:  { sparks: 5,  skins: ['banana'] },
    survive_night_10: { sparks: 10, tools: ['hacker'] },
};

// All valid pack skin ids (computed once)
const ALL_PACK_SKINS = new Set(
    Object.values(SKIN_PACKS).flatMap(p => p.skins.map(s => s.id))
);

function weightedRoll(pack_id) {
    const pack = SKIN_PACKS[pack_id];
    if (!pack) return null;
    const perRarity = {};
    pack.skins.forEach(s => perRarity[s.rarity] = (perRarity[s.rarity] || 0) + 1);
    const roll = Math.floor(Math.random() * 100) + 1;
    let cum = 0;
    for (const s of pack.skins) {
        cum += Math.floor(RARITY_POOL[s.rarity] / perRarity[s.rarity]);
        if (roll <= cum) return s;
    }
    return pack.skins[pack.skins.length - 1];
}

function weightedToolRoll() {
    const pack = TOOL_PACKS.tools;
    const perRarity = {};
    pack.items.forEach(s => perRarity[s.rarity] = (perRarity[s.rarity] || 0) + 1);
    const roll = Math.floor(Math.random() * 100) + 1;
    let cum = 0;
    for (const s of pack.items) {
        cum += Math.floor(RARITY_POOL[s.rarity] / perRarity[s.rarity]);
        if (roll <= cum) return s;
    }
    return pack.items[pack.items.length - 1];
}

function weightedClassRoll() {
    const pack = CLASS_PACKS.classes;
    const perRarity = {};
    pack.items.forEach(s => perRarity[s.rarity] = (perRarity[s.rarity] || 0) + 1);
    const roll = Math.floor(Math.random() * 100) + 1;
    let cum = 0;
    for (const s of pack.items) {
        cum += Math.floor(RARITY_POOL[s.rarity] / perRarity[s.rarity]);
        if (roll <= cum) return s;
    }
    return pack.items[pack.items.length - 1];
}

// ---------------------------------------------------------------------------
// Level / XP system
// ---------------------------------------------------------------------------

// XP needed to advance FROM level n (e.g. 100 xp to go from Lv1 → Lv2).
function xpForLevel(n) {
    return 100 * (n || 1);
}

// Add XP to an account, levelling up as needed.
function applyXP(acc, amount) {
    if (!acc.level) acc.level = 1;
    if (!acc.xp)    acc.xp   = 0;
    acc.xp += amount;
    while (acc.xp >= xpForLevel(acc.level)) {
        acc.xp    -= xpForLevel(acc.level);
        acc.level += 1;
    }
}

// Return the player_data block to embed in 'registered'
function playerDataBlock(acc) {
    const lv = acc.level ?? 1;
    return {
        sparks:                acc.sparks               ?? 0,
        unlocked_skins:        acc.unlocked_skins        ?? [],
        unlocked_tools:        acc.unlocked_tools        ?? [],
        unlocked_classes:      acc.unlocked_classes      ?? [],
        equipped_tools:        acc.equipped_tools        ?? [],
        unlocked_achievements: acc.unlocked_achievements ?? [],
        current_skin:          acc.current_skin          ?? 'default',
        current_class:         acc.current_class         ?? 'night_guard',
        level:                 lv,
        xp:                    acc.xp                    ?? 0,
        xp_needed:             xpForLevel(lv),
    };
}

const PORT      = process.env.PORT || 8765;
// DATA_DIR can be overridden by an env var so a persistent volume survives deployments.
// On Railway: set DATA_DIR=/data and mount a Volume at /data.
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Startup diagnostics — check Railway logs to verify this path is /data
console.log(`[startup] DATA_DIR  = ${DATA_DIR}`);
console.log(`[startup] DATA_FILE = ${DATA_FILE}`);
console.log(`[startup] DATA_DIR exists: ${fs.existsSync(DATA_DIR)}`);
console.log(`[startup] DATA_FILE exists: ${fs.existsSync(DATA_FILE)}`);

// ---------------------------------------------------------------------------
// Persistent account data
// ---------------------------------------------------------------------------
// {
//   username: {
//     passwordHash: string,
//     tokens:       string[],   // session tokens (up to 5, for multiple devices)
//     friends:      string[],
//     pendingIn:    string[],
//     pendingOut:   string[],
//     achievements: string[]    // for later!
//   }
// }

function loadAccounts() {
    if (fs.existsSync(DATA_FILE)) {
        try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
    }
    return {};
}
function saveAccounts() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2));
}

let accounts = loadAccounts();

// One-time developer spark grant — gives SimplyNumNum 250 sparks for testing.
// The _dev_spark_grant flag prevents it from re-running on subsequent restarts.
(function grantDevSparks() {
    const acc = accounts['SimplyNumNum'];
    if (acc && !acc._dev_spark_grant) {
        acc.sparks = (acc.sparks ?? 0) + 250;
        acc._dev_spark_grant = true;
        saveAccounts();
        console.log('[dev] Granted 250 sparks to SimplyNumNum (total: ' + acc.sparks + ')');
    }
})();

// ---------------------------------------------------------------------------
// Runtime state (lives only while server is running)
// ---------------------------------------------------------------------------

const clients    = new Map(); // ws → { username, x, y, lobby_id, skin }
const byName     = new Map(); // username → ws
const lobbies    = new Map(); // lobby_id → lobby object
const countdowns = new Map(); // lobby_id → { interval, remaining }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function isValidUsername(u) {
    return typeof u === 'string' && u.length >= 2 && u.length <= 20 && /^[a-zA-Z0-9_\- ]+$/.test(u);
}

function isValidPassword(p) {
    return typeof p === 'string' && p.length >= 6;
}

function send(ws, type, extra = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, ...extra }));
    }
}

function broadcastHub(type, extra, skip = null) {
    clients.forEach((p, ws) => {
        if (ws !== skip && !p.lobby_id) send(ws, type, extra);
    });
}

function notifyLobby(lobby_id, type, extra) {
    const lobby = lobbies.get(lobby_id);
    if (!lobby) return;
    lobby.players.forEach(u => {
        const ws = byName.get(u);
        if (ws) send(ws, type, extra);
    });
}

function lobbySummary(lobby) {
    return {
        id: lobby.id, name: lobby.name, host: lobby.host,
        max_players: lobby.max_players, is_public: lobby.is_public,
        players: lobby.players,
    };
}

function cancelCountdown(lobby_id, notify = true) {
    const cd = countdowns.get(lobby_id);
    if (!cd) return;
    clearInterval(cd.interval);
    countdowns.delete(lobby_id);
    if (notify) notifyLobby(lobby_id, 'countdown_cancelled', {});
}

function leaveLobby(player, ws) {
    const lobby = lobbies.get(player.lobby_id);
    if (!lobby) { player.lobby_id = null; return; }

    // Cancel any countdown if the host leaves or lobby empties
    cancelCountdown(lobby.id, true);

    lobby.players = lobby.players.filter(u => u !== player.username);
    player.lobby_id = null;

    if (lobby.players.length === 0) {
        lobbies.delete(lobby.id);
    } else {
        if (lobby.host === player.username) {
            lobby.host = lobby.players[0];
            notifyLobby(lobby.id, 'lobby_host_changed', { new_host: lobby.host });
        }
        notifyLobby(lobby.id, 'lobby_updated', { lobby: lobbySummary(lobby) });
    }
    send(ws, 'lobby_left', {});

    // Re-enter the hub: tell all current hub players this player is back,
    // and tell this player who is already in the hub (so their scene can spawn them).
    const acc = accounts[player.username] || {};
    broadcastHub('player_joined_hub', {
        username: player.username,
        x: player.x, y: player.y,
        skin: player.skin || 'default',
        level: acc.level ?? 1,
        current_class: acc.current_class ?? 'night_guard',
    }, ws);

    const hubPlayers = [];
    clients.forEach((p, w) => {
        if (w !== ws && !p.lobby_id) {
            const pa = accounts[p.username] || {};
            hubPlayers.push({ username: p.username, x: p.x, y: p.y, skin: p.skin || 'default', level: pa.level ?? 1, current_class: pa.current_class ?? 'night_guard' });
        }
    });
    send(ws, 'hub_state', { hubPlayers });
}

function handleStartCountdown(ws, player) {
    if (!player.lobby_id) return;
    const lobby = lobbies.get(player.lobby_id);
    if (!lobby || lobby.host !== player.username) return;
    if (countdowns.has(lobby.id)) return; // already running

    let remaining = 10;
    notifyLobby(lobby.id, 'countdown_started', { seconds: remaining });

    const interval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            cancelCountdown(lobby.id, false); // don't notify cancel
            // Ordered player list: index 0 = host (peer id 1), etc.
            notifyLobby(lobby.id, 'game_start', { players: [...lobby.players] });
        } else {
            notifyLobby(lobby.id, 'countdown_tick', { seconds: remaining });
        }
    }, 1000);

    countdowns.set(lobby.id, { interval });
}

function handleCancelCountdown(ws, player) {
    if (!player.lobby_id) return;
    const lobby = lobbies.get(player.lobby_id);
    if (!lobby || lobby.host !== player.username) return;
    cancelCountdown(lobby.id, true);
}

// ---------------------------------------------------------------------------
// Shared login completion (called after password/token verified)
// ---------------------------------------------------------------------------

function completeLogin(ws, username, token) {
    if (byName.has(username)) {
        send(ws, 'error', { message: 'This account is already logged in.' });
        return;
    }

    const acc = accounts[username];
    const player = { username, x: 400, y: 300, lobby_id: null, skin: 'default' };
    clients.set(ws, player);
    byName.set(username, ws);

    const hubPlayers = [];
    clients.forEach((p, w) => {
        if (w !== ws && !p.lobby_id) {
            const pa = accounts[p.username] || {};
            hubPlayers.push({ username: p.username, x: p.x, y: p.y, skin: p.skin || 'default', level: pa.level ?? 1, current_class: pa.current_class ?? 'night_guard' });
        }
    });

    send(ws, 'registered', {
        username,
        token,
        friends:       acc.friends,
        pendingIn:     acc.pendingIn,
        onlineFriends: acc.friends.filter(f => byName.has(f)),
        hubPlayers,
        player_data:   playerDataBlock(acc),
    });

    broadcastHub('player_joined_hub', { username, x: player.x, y: player.y, skin: player.skin, level: acc.level ?? 1, current_class: acc.current_class ?? 'night_guard' }, ws);

    acc.friends.forEach(f => {
        const fw = byName.get(f);
        if (fw) send(fw, 'friend_online', { username });
    });

    console.log(`[+] ${username}`);
}

// ---------------------------------------------------------------------------
// Auth handlers
// ---------------------------------------------------------------------------

async function handleRegister(ws, msg) {
    const { username, password } = msg;

    if (!isValidUsername(username)) {
        send(ws, 'error', { message: 'Username must be 2–20 chars (letters, numbers, spaces, _ -).' });
        return;
    }
    if (!isValidPassword(password)) {
        send(ws, 'error', { message: 'Password must be at least 6 characters.' });
        return;
    }
    if (accounts[username]) {
        send(ws, 'error', { message: 'That username is already taken. Try another or log in.' });
        return;
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const token = generateToken();
        accounts[username] = {
            passwordHash,
            tokens:                [token],
            friends:               [],
            pendingIn:             [],
            pendingOut:            [],
            // Server-authoritative player progression
            sparks:                0,
            unlocked_skins:        [],
            unlocked_tools:        [],
            unlocked_classes:      [],
            equipped_tools:        [],
            unlocked_achievements: [],
            current_skin:          'default',
            current_class:         'night_guard',
        };
        saveAccounts();
        completeLogin(ws, username, token);
    } catch (err) {
        console.error('Register error:', err);
        send(ws, 'error', { message: 'Server error during registration. Please try again.' });
    }
}

async function handleLogin(ws, msg) {
    const { username, password } = msg;
    const acc = accounts[username];

    if (!acc) {
        send(ws, 'error', { message: 'No account found with that username.' });
        return;
    }

    try {
        const valid = await bcrypt.compare(password, acc.passwordHash);
        if (!valid) {
            send(ws, 'error', { message: 'Incorrect password.' });
            return;
        }

        const token = generateToken();
        acc.tokens.push(token);
        if (acc.tokens.length > 5) acc.tokens.shift(); // keep last 5
        saveAccounts();
        completeLogin(ws, username, token);
    } catch (err) {
        console.error('Login error:', err);
        send(ws, 'error', { message: 'Server error during login. Please try again.' });
    }
}

function handleAutoLogin(ws, msg) {
    const { username, token } = msg;
    const acc = accounts[username];

    if (!acc || !acc.tokens.includes(token)) {
        send(ws, 'token_invalid', {});
        return;
    }
    completeLogin(ws, username, token);
}

// ---------------------------------------------------------------------------
// Social handlers (same as before)
// ---------------------------------------------------------------------------

const VALID_SIZES = new Set([1, 2, 3, 4, 8]);

function handleHubMove(ws, msg, player) {
    player.x = msg.x;
    player.y = msg.y;
    broadcastHub('player_moved', { username: player.username, x: msg.x, y: msg.y }, ws);
}

function handleHubChat(ws, msg, player) {
    if (player.lobby_id) return; // hub only
    const text = (typeof msg.text === 'string') ? msg.text.trim().slice(0, 100) : '';
    if (!text) return;
    broadcastHub('hub_chat', { username: player.username, text }, ws);
    send(ws, 'hub_chat', { username: player.username, text }); // echo to sender
}

function handleHubEmote(ws, msg, player) {
    if (player.lobby_id) return;  // only broadcast when in the hub
    const emote = (typeof msg.emote === 'string' && msg.emote.length <= 32) ? msg.emote : '';
    if (!emote) return;
    broadcastHub('hub_emote', { username: player.username, emote }, ws);
}

function handleSetSkin(ws, msg, player) {
    const skin = (typeof msg.skin === 'string' && msg.skin.length <= 32) ? msg.skin : 'default';
    const acc = accounts[player.username];

    // Validate ownership
    if (OWNER_SKINS[skin] && OWNER_SKINS[skin] !== player.username) return;
    if (ALL_PACK_SKINS.has(skin) || ACHIEVEMENT_SKINS.has(skin)) {
        if (!(acc.unlocked_skins ?? []).includes(skin)) return;
    }

    acc.current_skin = skin;
    player.skin = skin;
    saveAccounts();
    broadcastHub('player_skin_changed', { username: player.username, skin }, ws);
}

// ---------------------------------------------------------------------------
// Player progression handlers
// ---------------------------------------------------------------------------

function handleRollPack(ws, msg, player) {
    const { pack_id, count } = msg;
    const is_tool_roll  = (pack_id === 'tools');
    const is_class_roll = (pack_id === 'classes');
    if (!is_tool_roll && !is_class_roll && !SKIN_PACKS[pack_id]) return;
    const cost_table = is_tool_roll ? TOOL_ROLL_COST : (is_class_roll ? CLASS_ROLL_COST : ROLL_COST);
    if (!cost_table[count]) return;

    const cost = cost_table[count];
    const acc  = accounts[player.username];
    if ((acc.sparks ?? 0) < cost) {
        send(ws, 'error', { message: 'Not enough sparks.' });
        return;
    }

    acc.sparks = (acc.sparks ?? 0) - cost;

    const results        = [];
    const newly_unlocked = [];
    let   refund_total   = 0;

    if (is_tool_roll) {
        // Tool roll — adds to unlocked_tools
        if (!acc.unlocked_tools) acc.unlocked_tools = [];
        for (let i = 0; i < count; i++) {
            const entry = weightedToolRoll();
            const tid   = entry.id;
            const already_owned = acc.unlocked_tools.includes(tid) || newly_unlocked.includes(tid);
            if (already_owned) {
                refund_total += RARITY_REFUND[entry.rarity] ?? 2;
            } else {
                acc.unlocked_tools.push(tid);
                newly_unlocked.push(tid);
            }
            results.push(tid);
        }
    } else if (is_class_roll) {
        // Class roll — adds to unlocked_classes
        if (!acc.unlocked_classes) acc.unlocked_classes = [];
        for (let i = 0; i < count; i++) {
            const entry = weightedClassRoll();
            const cid   = entry.id;
            const already_owned = acc.unlocked_classes.includes(cid) || newly_unlocked.includes(cid);
            if (already_owned) {
                refund_total += RARITY_REFUND[entry.rarity] ?? 2;
            } else {
                acc.unlocked_classes.push(cid);
                newly_unlocked.push(cid);
            }
            results.push(cid);
        }
    } else {
        // Skin roll — adds to unlocked_skins
        if (!acc.unlocked_skins) acc.unlocked_skins = [];
        for (let i = 0; i < count; i++) {
            const entry = weightedRoll(pack_id);
            const sid   = entry.id;
            const already_owned = acc.unlocked_skins.includes(sid) || newly_unlocked.includes(sid);
            if (already_owned) {
                refund_total += RARITY_REFUND[entry.rarity] ?? 2;
            } else {
                acc.unlocked_skins.push(sid);
                newly_unlocked.push(sid);
            }
            results.push(sid);
        }
    }

    acc.sparks += refund_total;
    saveAccounts();

    const result_type = is_tool_roll ? 'tool' : (is_class_roll ? 'class' : 'skin');
    send(ws, 'roll_result', {
        results,
        newly_unlocked,
        refund_total,
        new_sparks:  acc.sparks,
        result_type,
    });
}

// ---------------------------------------------------------------------------
// Night-win rewards — single atomic call replaces grant_sparks + unlock_achievement
// ---------------------------------------------------------------------------

function sparksForNight(night) {
    if (night <= 3)  return 0;
    if (night <= 5)  return 1;
    if (night <= 8)  return 2;
    if (night === 9) return 3;
    return 5; // night 10
}

function handleNightComplete(ws, msg, player) {
    const night = Math.floor(Number(msg.night));
    if (!Number.isFinite(night) || night < 1 || night > 10) {
        console.warn(`[night_complete] REJECTED — invalid night=${msg.night} from ${player.username}`);
        return;
    }

    const acc = accounts[player.username];
    if (!acc.unlocked_achievements) acc.unlocked_achievements = [];
    if (!acc.unlocked_skins)        acc.unlocked_skins        = [];
    if (!acc.unlocked_tools)        acc.unlocked_tools        = [];

    let sparks_earned = sparksForNight(night);
    const achievements_earned = [];

    // Night-completion sparks
    acc.sparks = (acc.sparks ?? 0) + sparks_earned;

    // Night-completion XP (night × 10)
    applyXP(acc, night * 10);

    // Night 5 achievement
    if (night >= 5 && !acc.unlocked_achievements.includes('survive_night_5')) {
        const r = ACHIEVEMENT_REWARDS['survive_night_5'];
        acc.unlocked_achievements.push('survive_night_5');
        acc.sparks += (r.sparks ?? 0);
        sparks_earned  += (r.sparks ?? 0);
        (r.skins ?? []).forEach(s => { if (!acc.unlocked_skins.includes(s)) acc.unlocked_skins.push(s); });
        achievements_earned.push('survive_night_5');
    }

    // Night 10 achievement
    if (night >= 10 && !acc.unlocked_achievements.includes('survive_night_10')) {
        const r = ACHIEVEMENT_REWARDS['survive_night_10'];
        acc.unlocked_achievements.push('survive_night_10');
        acc.sparks += (r.sparks ?? 0);
        sparks_earned  += (r.sparks ?? 0);
        (r.skins ?? []).forEach(s => { if (!acc.unlocked_skins.includes(s)) acc.unlocked_skins.push(s); });
        (r.tools ?? []).forEach(t => { if (!acc.unlocked_tools.includes(t)) acc.unlocked_tools.push(t); });
        achievements_earned.push('survive_night_10');
    }

    saveAccounts();
    console.log(`[night_complete] ${player.username} night=${night} sparks_earned=${sparks_earned} achievements=[${achievements_earned}] total_sparks=${acc.sparks}`);

    send(ws, 'night_complete_result', {
        night,
        sparks_earned,
        achievements_earned,
        player_data: playerDataBlock(acc),
    });
}

function handleRequestPlayerData(ws, player) {
    const acc = accounts[player.username];
    console.log(`[sync] ${player.username} requested player data sync`);
    send(ws, 'player_data_synced', { player_data: playerDataBlock(acc) });
}

function handleGrantSparks(ws, msg, player) {
    const amount = Math.floor(Number(msg.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 50) {
        console.warn(`[grant_sparks] REJECTED for ${player.username} — amount=${msg.amount}`);
        return;
    }
    const acc = accounts[player.username];
    const before = acc.sparks ?? 0;
    acc.sparks = before + amount;
    saveAccounts();
    console.log(`[grant_sparks] ${player.username}: ${before} + ${amount} = ${acc.sparks}`);
    send(ws, 'sparks_updated', { new_sparks: acc.sparks });
}

function handleUnlockAchievement(ws, msg, player) {
    const { ach_id } = msg;
    const rewards = ACHIEVEMENT_REWARDS[ach_id];
    if (!rewards) {
        console.warn(`[achievement] UNKNOWN ach_id="${ach_id}" from ${player.username}`);
        return;
    }

    const acc = accounts[player.username];
    if (!acc.unlocked_achievements) acc.unlocked_achievements = [];
    if (acc.unlocked_achievements.includes(ach_id)) {
        console.log(`[achievement] ${player.username} already has "${ach_id}" — skipping`);
        return;
    }

    acc.unlocked_achievements.push(ach_id);
    if (rewards.sparks) acc.sparks = (acc.sparks ?? 0) + rewards.sparks;
    if (rewards.skins)  rewards.skins.forEach(s => {
        if (!acc.unlocked_skins) acc.unlocked_skins = [];
        if (!acc.unlocked_skins.includes(s)) acc.unlocked_skins.push(s);
    });
    if (rewards.tools)  rewards.tools.forEach(t => {
        if (!acc.unlocked_tools) acc.unlocked_tools = [];
        if (!acc.unlocked_tools.includes(t)) acc.unlocked_tools.push(t);
    });
    // Achievement XP bonus: 25 XP per achievement
    applyXP(acc, 25);
    saveAccounts();
    console.log(`[achievement] ${player.username} unlocked "${ach_id}" → sparks=${acc.sparks}, skins=[${acc.unlocked_skins}], level=${acc.level}`);

    send(ws, 'achievement_unlocked', {
        ach_id,
        new_sparks:     acc.sparks,
        unlocked_skins: acc.unlocked_skins,
        unlocked_tools: acc.unlocked_tools,
    });
}

function handleSetEquippedTools(ws, msg, player) {
    const { tools } = msg;
    if (!Array.isArray(tools)) return;
    const acc   = accounts[player.username];
    const valid = tools.filter(t => (acc.unlocked_tools ?? []).includes(t)).slice(0, 3);
    acc.equipped_tools = valid;
    saveAccounts();
}

function handleSetClass(ws, msg, player) {
    const class_id = msg.class_id;
    if (typeof class_id !== 'string') return;
    const acc = accounts[player.username];
    // night_guard is always valid; rollable classes must be unlocked
    const ALL_CLASS_IDS = new Set(['night_guard', ...CLASS_PACKS.classes.items.map(c => c.id)]);
    if (!ALL_CLASS_IDS.has(class_id)) return;
    if (class_id !== 'night_guard' && !(acc.unlocked_classes ?? []).includes(class_id)) return;
    acc.current_class = class_id;
    saveAccounts();
    // Broadcast class change to hub so other players see updated label
    broadcastHub('player_class_changed', { username: player.username, current_class: class_id });
}

function handleFriendRequest(ws, msg, player) {
    const target = msg.target_username;
    if (!target || target === player.username) return;

    const acc  = accounts[player.username];
    const tacc = accounts[target];
    if (!tacc) { send(ws, 'error', { message: `No account found for "${target}".` }); return; }
    if (acc.friends.includes(target)) { send(ws, 'error', { message: 'Already friends.' }); return; }
    if (acc.pendingOut.includes(target)) { send(ws, 'error', { message: 'Request already sent.' }); return; }

    if (acc.pendingIn.includes(target)) {
        acc.friends.push(target);
        acc.pendingIn = acc.pendingIn.filter(u => u !== target);
        tacc.friends.push(player.username);
        tacc.pendingOut = tacc.pendingOut.filter(u => u !== player.username);
        saveAccounts();
        send(ws, 'friend_added', { username: target });
        const tw = byName.get(target);
        if (tw) send(tw, 'friend_added', { username: player.username });
        return;
    }

    acc.pendingOut.push(target);
    tacc.pendingIn.push(player.username);
    saveAccounts();
    send(ws, 'friend_request_sent', { target });
    const tw = byName.get(target);
    if (tw) send(tw, 'friend_request_received', { from: player.username });
}

function handleFriendAccept(ws, msg, player) {
    const { from } = msg;
    const acc  = accounts[player.username];
    const facc = accounts[from];
    if (!facc || !acc.pendingIn.includes(from)) return;

    acc.friends.push(from);
    acc.pendingIn = acc.pendingIn.filter(u => u !== from);
    facc.friends.push(player.username);
    facc.pendingOut = facc.pendingOut.filter(u => u !== player.username);
    saveAccounts();

    send(ws, 'friend_added', { username: from });
    const fw = byName.get(from);
    if (fw) send(fw, 'friend_added', { username: player.username });
}

function handleFriendDecline(ws, msg, player) {
    const { from } = msg;
    const acc  = accounts[player.username];
    const facc = accounts[from];
    if (!facc) return;
    acc.pendingIn = acc.pendingIn.filter(u => u !== from);
    facc.pendingOut = facc.pendingOut.filter(u => u !== player.username);
    saveAccounts();
    send(ws, 'friend_request_declined', { from });
}

function handleRemoveFriend(ws, msg, player) {
    const { target } = msg;
    const acc  = accounts[player.username];
    const tacc = accounts[target];
    if (!acc) return;
    acc.friends = acc.friends.filter(u => u !== target);
    if (tacc) tacc.friends = tacc.friends.filter(u => u !== player.username);
    saveAccounts();
    send(ws, 'friend_removed', { username: target });
    const tw = byName.get(target);
    if (tw) send(tw, 'friend_removed', { username: player.username });
}

function handleCreateLobby(ws, msg, player) {
    if (player.lobby_id) { send(ws, 'error', { message: 'Leave your current lobby first.' }); return; }
    if (!VALID_SIZES.has(msg.max_players)) { send(ws, 'error', { message: 'Invalid lobby size.' }); return; }

    const lobby_id = `${player.username}_${Date.now()}`;
    const lobby = {
        id: lobby_id,
        name: (msg.lobby_name || `${player.username}'s Lobby`).slice(0, 40),
        host: player.username,
        max_players: msg.max_players,
        is_public: !!msg.is_public,
        players: [player.username],
        invited: [],
    };
    lobbies.set(lobby_id, lobby);
    player.lobby_id = lobby_id;
    send(ws, 'lobby_created', { lobby: lobbySummary(lobby) });
}

function handleJoinLobby(ws, msg, player) {
    if (player.lobby_id) { send(ws, 'error', { message: 'Leave your current lobby first.' }); return; }
    const lobby = lobbies.get(msg.lobby_id);
    if (!lobby) { send(ws, 'error', { message: 'Lobby not found.' }); return; }
    if (lobby.players.length >= lobby.max_players) { send(ws, 'error', { message: 'Lobby is full.' }); return; }
    if (!lobby.is_public && !lobby.invited.includes(player.username)) {
        send(ws, 'error', { message: 'This lobby is invite only.' }); return;
    }

    lobby.players.push(player.username);
    player.lobby_id = lobby.id;
    send(ws, 'lobby_joined', { lobby: lobbySummary(lobby) });
    notifyLobby(lobby.id, 'lobby_updated', { lobby: lobbySummary(lobby) });
}

function handleLobbyInvite(ws, msg, player) {
    if (!player.lobby_id) return;
    const lobby = lobbies.get(player.lobby_id);
    if (!lobby || lobby.host !== player.username) return;
    const target = msg.target_username;
    if (!lobby.invited.includes(target)) lobby.invited.push(target);
    const tw = byName.get(target);
    if (tw) send(tw, 'lobby_invite_received', { lobby_id: lobby.id, lobby_name: lobby.name, from: player.username });
}

function handleGetPublicLobbies(ws) {
    const list = [];
    lobbies.forEach(lobby => {
        if (lobby.is_public && lobby.players.length < lobby.max_players) list.push(lobbySummary(lobby));
    });
    send(ws, 'public_lobbies', { lobbies: list });
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocket.Server({ port: PORT });
console.log(`Relay server listening on port ${PORT}`);

wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        const player = clients.get(ws);

        // Auth messages are allowed before login
        if (!player) {
            switch (msg.type) {
                case 'register':   await handleRegister(ws, msg);  break;
                case 'login':      await handleLogin(ws, msg);     break;
                case 'auto_login': handleAutoLogin(ws, msg);        break;
            }
            return;
        }

        // All other messages require being logged in
        switch (msg.type) {
            case 'hub_move':             handleHubMove(ws, msg, player);            break;
            case 'hub_emote':            handleHubEmote(ws, msg, player);           break;
            case 'hub_chat':             handleHubChat(ws, msg, player);            break;
            case 'set_skin':             handleSetSkin(ws, msg, player);            break;
            case 'night_complete':       handleNightComplete(ws, msg, player);      break;
            case 'request_player_data':  handleRequestPlayerData(ws, player);       break;
            case 'roll_pack':            handleRollPack(ws, msg, player);           break;
            case 'grant_sparks':         handleGrantSparks(ws, msg, player);        break;
            case 'unlock_achievement':   handleUnlockAchievement(ws, msg, player);  break;
            case 'set_equipped_tools':   handleSetEquippedTools(ws, msg, player);   break;
            case 'set_class':            handleSetClass(ws, msg, player);           break;
            case 'friend_request':    handleFriendRequest(ws, msg, player); break;
            case 'friend_accept':     handleFriendAccept(ws, msg, player);  break;
            case 'friend_decline':    handleFriendDecline(ws, msg, player); break;
            case 'remove_friend':     handleRemoveFriend(ws, msg, player);  break;
            case 'create_lobby':      handleCreateLobby(ws, msg, player);   break;
            case 'join_lobby':        handleJoinLobby(ws, msg, player);     break;
            case 'leave_lobby':       if (player.lobby_id) leaveLobby(player, ws); break;
            case 'lobby_invite':      handleLobbyInvite(ws, msg, player);   break;
            case 'get_public_lobbies':  handleGetPublicLobbies(ws);              break;
            case 'start_countdown':     handleStartCountdown(ws, player);        break;
            case 'cancel_countdown':    handleCancelCountdown(ws, player);       break;

            // In-game relay — forwards data to all other players in the same lobby
            case 'game_relay': {
                const lobby = lobbies.get(player.lobby_id);
                if (lobby) {
                    lobby.players.forEach(u => {
                        if (u !== player.username) {
                            const tw = byName.get(u);
                            if (tw) send(tw, 'game_relay', { from: player.username, data: msg.data });
                        }
                    });
                }
                break;
            }
            // Keepalive ping — keeps the WebSocket alive during idle gameplay
            case 'ping':
                send(ws, 'pong', {});
                break;
            // Ping echo — bounced straight back to measure relay latency
            case 'game_ping':
                send(ws, 'game_pong', { time: msg.time });
                break;
            case 'webrtc_offer':
            case 'webrtc_answer':
            case 'webrtc_ice': {
                const tw = byName.get(msg.target);
                if (tw) send(tw, msg.type, { from: player.username, data: msg.data });
                break;
            }
        }
    });

    ws.on('close', () => {
        const player = clients.get(ws);
        if (!player) return;
        const { username } = player;

        if (player.lobby_id) leaveLobby(player, ws);
        broadcastHub('player_left_hub', { username });

        const acc = accounts[username];
        if (acc) {
            acc.friends.forEach(f => {
                const fw = byName.get(f);
                if (fw) send(fw, 'friend_offline', { username });
            });
        }

        clients.delete(ws);
        byName.delete(username);
        console.log(`[-] ${username}`);
    });

    ws.on('error', err => console.error('WebSocket error:', err.message));
});
