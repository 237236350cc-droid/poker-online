const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'] });
app.use(express.static('public'));

const rooms = new Map();
const FULL_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠', '♥', '♣', '♦'];

function createDeck() {
    let deck = [];
    for (let suit of SUITS) for (let rank of FULL_RANKS) deck.push({ rank, suit });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function rankValue(rank) { return FULL_RANKS.indexOf(rank); }

function checkStraight(values) {
    let uniq = [...new Set(values)].sort((a,b)=>a-b);
    for(let i=0;i<=uniq.length-5;i++) if(uniq[i+4]-uniq[i] === 4) return true;
    if(uniq.includes(12) && uniq.includes(0) && uniq.includes(1) && uniq.includes(2) && uniq.includes(3)) return true;
    return false;
}

function getHandRankNameAndLevel(cards) {
    let vals = cards.map(c=>rankValue(c.rank));
    vals.sort((a,b)=>a-b);
    let isFlush = cards.every(c=>c.suit === cards[0].suit);
    let isStraight = checkStraight(vals);
    let counts = new Map();
    for(let v of vals) counts.set(v, (counts.get(v)||0)+1);
    let countArr = Array.from(counts.values()).sort((a,b)=>b-a);
    let rankCounts = Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]);
    let highRank = rankCounts[0][0];
    let highRankName = FULL_RANKS[highRank];
    
    if(isFlush && isStraight) return { level: 8, name: "同花顺" };
    if(countArr[0] === 4) return { level: 7, name: `四条 ${highRankName}` };
    if(countArr[0] === 3 && countArr[1] === 2) return { level: 6, name: `葫芦 ${highRankName}` };
    if(isFlush) return { level: 5, name: "同花" };
    if(isStraight) return { level: 4, name: "顺子" };
    if(countArr[0] === 3) return { level: 3, name: `三条 ${highRankName}` };
    if(countArr[0] === 2 && countArr[1] === 2) return { level: 2, name: `两对` };
    if(countArr[0] === 2) return { level: 1, name: `一对 ${highRankName}` };
    return { level: 0, name: `高牌 ${highRankName}` };
}

function createRoom(roomId, hostId, startingChips) {
    return {
        roomId, hostId, startingChips,
        players: [],
        communityCards: [],
        pot: 0,
        currentRound: 'preflop',
        currentPlayerIdx: 0,
        lastBet: 0,
        deck: [],
        gameActive: false,
        gameStarted: false
    };
}

function broadcastState(room) {
    for (let target of room.players) {
        io.to(target.id).emit('gameState', {
            myId: target.id,
            players: room.players.map(p => ({
                id: p.id, name: p.name, chips: p.chips, bet: p.bet,
                currentBet: p.currentBet, folded: p.folded,
                hand: p.id === target.id ? p.hand : []
            })),
            communityCards: room.communityCards,
            pot: room.pot,
            currentPlayerIdx: room.currentPlayerIdx,
            currentRound: room.currentRound,
            lastBet: room.lastBet,
            gameActive: room.gameActive,
            gameStarted: room.gameStarted
        });
    }
}

// 获取下一个未弃牌的玩家索引
function getNextActivePlayer(room, startIdx) {
    for (let i = 1; i <= room.players.length; i++) {
        let idx = (startIdx + i) % room.players.length;
        if (!room.players[idx].folded) return idx;
    }
    return startIdx; // 返回原索引（理论上不会发生）
}

// 检查是否所有未弃牌玩家下注额相等
function isRoundComplete(room) {
    let active = room.players.filter(p => !p.folded);
    if (active.length <= 1) return true;
    return active.every(p => p.currentBet === room.lastBet);
}

// 核心：切换到下一个玩家或下一阶段
function moveToNext(room) {
    let activePlayers = room.players.filter(p => !p.folded);
    
    // 只剩一人，直接获胜
    if (activePlayers.length === 1) {
        let winner = activePlayers[0];
        winner.chips += room.pot;
        io.to(room.roomId).emit('gameMessage', `🏆 ${winner.name} 赢得底池 ${room.pot} 筹码！`);
        room.pot = 0;
        room.gameActive = false;
        broadcastState(room);
        return;
    }
    
    // 检查本轮是否完成
    if (isRoundComplete(room)) {
        // 进入下一阶段
        for (let p of room.players) p.currentBet = 0;
        room.lastBet = 0;
        
        if (room.currentRound === 'preflop') {
            room.communityCards = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
            room.currentRound = 'flop';
            io.to(room.roomId).emit('gameMessage', "🔥 翻牌圈");
            room.currentPlayerIdx = getNextActivePlayer(room, 0);
        } else if (room.currentRound === 'flop') {
            room.communityCards.push(room.deck.pop());
            room.currentRound = 'turn';
            io.to(room.roomId).emit('gameMessage', "🔄 转牌圈");
            room.currentPlayerIdx = getNextActivePlayer(room, 0);
        } else if (room.currentRound === 'turn') {
            room.communityCards.push(room.deck.pop());
            room.currentRound = 'river';
            io.to(room.roomId).emit('gameMessage', "🌊 河牌圈");
            room.currentPlayerIdx = getNextActivePlayer(room, 0);
        } else if (room.currentRound === 'river') {
            // 摊牌
            let active = room.players.filter(p => !p.folded);
            let ranked = active.map(p => ({
                player: p,
                ...getHandRankNameAndLevel([...p.hand, ...room.communityCards])
            })).sort((a,b) => b.level - a.level);
            let msg = "🃟 摊牌结果：\n";
            for (let r of ranked) msg += `${r.player.name}: ${r.name}\n`;
            io.to(room.roomId).emit('gameMessage', msg);
            let winner = ranked[0].player;
            winner.chips += room.pot;
            io.to(room.roomId).emit('gameMessage', `🏆 ${winner.name} 以 ${ranked[0].name} 赢下底池 ${room.pot} 筹码！`);
            room.pot = 0;
            room.gameActive = false;
            broadcastState(room);
            return;
        }
        broadcastState(room);
        return;
    }
    
    // 本轮未完成，切换到下一个玩家
    let nextIdx = getNextActivePlayer(room, room.currentPlayerIdx);
    room.currentPlayerIdx = nextIdx;
    broadcastState(room);
}

function startNewHand(room) {
    for (let p of room.players) {
        p.bet = 0; p.currentBet = 0; p.folded = false; p.hand = [];
    }
    room.communityCards = [];
    room.pot = 0;
    room.currentRound = 'preflop';
    room.lastBet = 0;
    room.gameActive = true;
    room.gameStarted = true;
    room.deck = createDeck();
    
    // 发牌
    for (let p of room.players) p.hand = [room.deck.pop(), room.deck.pop()];
    
    // 盲注
    let sbIdx = 1 % room.players.length;
    let bbIdx = 2 % room.players.length;
    
    if (room.players[sbIdx].chips >= 10) {
        room.players[sbIdx].chips -= 10;
        room.players[sbIdx].bet = 10;
        room.players[sbIdx].currentBet = 10;
        room.pot += 10;
    }
    if (room.players[bbIdx].chips >= 20) {
        room.players[bbIdx].chips -= 20;
        room.players[bbIdx].bet = 20;
        room.players[bbIdx].currentBet = 20;
        room.pot += 20;
    }
    room.lastBet = 20;
    room.currentPlayerIdx = getNextActivePlayer(room, bbIdx);
    
    io.to(room.roomId).emit('gameMessage', `🎲 游戏开始！小盲:${room.players[sbIdx].name}(10) 大盲:${room.players[bbIdx].name}(20)`);
    broadcastState(room);
}

function resetGame(room) {
    room.gameStarted = false;
    room.gameActive = false;
    broadcastState(room);
    io.to(room.roomId).emit('gameMessage', '✨ 牌局已重置，点击"开始游戏"');
}

io.on('connection', (socket) => {
    socket.on('createRoom', ({ playerName, startingChips }) => {
        let roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        let room = createRoom(roomId, socket.id, startingChips);
        room.players.push({ id: socket.id, name: playerName, chips: startingChips, startingChips, bet: 0, currentBet: 0, hand: [], folded: false });
        rooms.set(roomId, room);
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, playerId: socket.id, startingChips });
        io.to(roomId).emit('playerJoined', { players: room.players.map(p => ({ id: p.id, name: p.name })) });
        io.to(roomId).emit('gameMessage', `✨ ${playerName} 创建房间，房间号: ${roomId}`);
    });
    
    socket.on('joinRoom', ({ roomId, playerName }) => {
        let room = rooms.get(roomId);
        if (!room) return socket.emit('error', '房间不存在');
        if (room.players.length >= 6) return socket.emit('error', '房间已满');
        if (room.gameStarted) return socket.emit('error', '游戏已开始');
        
        socket.join(roomId);
        room.players.push({ id: socket.id, name: playerName, chips: room.startingChips, startingChips: room.startingChips, bet: 0, currentBet: 0, hand: [], folded: false });
        socket.emit('joinSuccess', { roomId, playerId: socket.id, startingChips: room.startingChips });
        io.to(roomId).emit('playerJoined', { players: room.players.map(p => ({ id: p.id, name: p.name })) });
        io.to(roomId).emit('gameMessage', `🎉 ${playerName} 加入房间 (${room.players.length}/6人)`);
        broadcastState(room);
    });
    
    socket.on('startGame', ({ roomId }) => {
        let room = rooms.get(roomId);
        if (room && !room.gameStarted && room.players.length >= 2 && room.hostId === socket.id) startNewHand(room);
    });
    
    socket.on('resetGame', ({ roomId }) => {
        let room = rooms.get(roomId);
        if (room && room.hostId === socket.id) resetGame(room);
    });
    
    socket.on('playerAction', ({ roomId, action, amount }) => {
        let room = rooms.get(roomId);
        if (!room || !room.gameActive) return;
        
        let pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx !== room.currentPlayerIdx) {
            console.log(`不是当前玩家: 当前=${room.currentPlayerIdx}, 操作者=${pIdx}`);
            return;
        }
        if (room.players[pIdx].folded) return;
        
        let player = room.players[pIdx];
        
        if (action === 'fold') {
            player.folded = true;
            io.to(roomId).emit('gameMessage', `${player.name} 弃牌`);
            moveToNext(room);
        } 
        else if (action === 'check') {
            if (player.currentBet === room.lastBet) {
                io.to(roomId).emit('gameMessage', `${player.name} 过牌`);
                moveToNext(room);
            } else {
                io.to(roomId).emit('gameMessage', `${player.name} 无法过牌，前面有下注`);
            }
        }
        else if (action === 'call') {
            let need = room.lastBet - player.currentBet;
            if (need > player.chips) need = player.chips;
            player.chips -= need;
            player.bet += need;
            player.currentBet += need;
            room.pot += need;
            io.to(roomId).emit('gameMessage', `${player.name} 跟注 ${need}`);
            moveToNext(room);
        } 
        else if (action === 'raise' && amount) {
            let need = room.lastBet - player.currentBet;
            let total = need + amount;
            if (total > player.chips) total = player.chips;
            if (total <= need) {
                io.to(roomId).emit('gameMessage', `${player.name} 加注失败`);
                return;
            }
            let actual = total - need;
            player.chips -= total;
            player.bet += total;
            player.currentBet += total;
            room.pot += total;
            room.lastBet = player.currentBet;
            io.to(roomId).emit('gameMessage', `${player.name} 加注 ${actual}`);
            moveToNext(room);
        }
    });
    
    socket.on('disconnect', () => {
        for (let [roomId, room] of rooms.entries()) {
            let idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                let left = room.players[idx];
                room.players.splice(idx, 1);
                io.to(roomId).emit('playerLeft', { players: room.players.map(p => ({ id: p.id, name: p.name })) });
                io.to(roomId).emit('gameMessage', `👋 ${left.name} 离开`);
                if (room.players.length === 0) rooms.delete(roomId);
                else if (room.hostId === socket.id) room.hostId = room.players[0].id;
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器运行在 http://localhost:${PORT}`));
