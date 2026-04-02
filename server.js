const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

// 游戏房间存储
const rooms = new Map();

// 牌型相关常量
const FULL_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠', '♥', '♣', '♦'];

function createDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let rank of FULL_RANKS) {
            deck.push({ rank, suit });
        }
    }
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

function getHandRank(cards) {
    let vals = cards.map(c=>rankValue(c.rank));
    vals.sort((a,b)=>a-b);
    let isFlush = cards.every(c=>c.suit === cards[0].suit);
    let isStraight = checkStraight(vals);
    let counts = new Map();
    for(let v of vals) counts.set(v, (counts.get(v)||0)+1);
    let countArr = Array.from(counts.values()).sort((a,b)=>b-a);
    let hasFour = countArr[0] === 4;
    let hasThree = countArr[0] === 3;
    let hasPair = countArr[0] === 2;
    let twoPair = hasPair && countArr[1] === 2;
    let fullHouse = hasThree && countArr[1] === 2;
    if(isFlush && isStraight) return 8;
    if(hasFour) return 7;
    if(fullHouse) return 6;
    if(isFlush) return 5;
    if(isStraight) return 4;
    if(hasThree) return 3;
    if(twoPair) return 2;
    if(hasPair) return 1;
    return 0;
}

function compareHands(hand1, hand2, community) {
    let cards1 = [...hand1, ...community];
    let cards2 = [...hand2, ...community];
    let rank1 = getHandRank(cards1);
    let rank2 = getHandRank(cards2);
    if(rank1 !== rank2) return rank1 > rank2 ? 1 : -1;
    let val1 = cards1.map(c=>rankValue(c.rank)).sort((a,b)=>b-a);
    let val2 = cards2.map(c=>rankValue(c.rank)).sort((a,b)=>b-a);
    for(let i=0;i<val1.length;i++) if(val1[i] !== val2[i]) return val1[i] > val2[i] ? 1 : -1;
    return 0;
}

function createRoom(roomId, hostId) {
    return {
        roomId,
        players: [],
        communityCards: [],
        pot: 0,
        currentRound: 'preflop',
        currentPlayerIndex: 0,
        lastBet: 0,
        minRaise: 20,
        deck: [],
        gameActive: false,
        gameStarted: false,
        waitingForAction: false,
        hostId: hostId
    };
}

function broadcastGameState(room) {
    for (let player of room.players) {
        const playerState = {
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                bet: p.bet,
                currentBet: p.currentBet,
                folded: p.folded,
                hand: p.id === player.id ? p.hand : []
            })),
            communityCards: room.communityCards,
            pot: room.pot,
            currentPlayerIndex: room.currentPlayerIndex,
            currentRound: room.currentRound,
            lastBet: room.lastBet,
            minRaise: room.minRaise,
            gameActive: room.gameActive,
            gameStarted: room.gameStarted,
            gameEnded: !room.gameActive && room.gameStarted
        };
        io.to(player.id).emit('gameState', playerState);
    }
}

function startNewHand(room) {
    for (let p of room.players) {
        p.bet = 0;
        p.currentBet = 0;
        p.folded = false;
        p.hand = [];
    }
    room.communityCards = [];
    room.pot = 0;
    room.currentRound = 'preflop';
    room.lastBet = 0;
    room.minRaise = 20;
    room.gameActive = true;
    room.gameStarted = true;
    room.waitingForAction = false;
    room.deck = createDeck();
    
    for (let i = 0; i < room.players.length; i++) {
        room.players[i].hand = [room.deck.pop(), room.deck.pop()];
    }
    
    let sbIdx = 1 % room.players.length;
    let bbIdx = 2 % room.players.length;
    let smallBlind = 10;
    let bigBlind = 20;
    
    if (room.players[sbIdx].chips >= smallBlind) {
        room.players[sbIdx].chips -= smallBlind;
        room.players[sbIdx].bet = smallBlind;
        room.players[sbIdx].currentBet = smallBlind;
        room.pot += smallBlind;
    }
    if (room.players[bbIdx].chips >= bigBlind) {
        room.players[bbIdx].chips -= bigBlind;
        room.players[bbIdx].bet = bigBlind;
        room.players[bbIdx].currentBet = bigBlind;
        room.pot += bigBlind;
    }
    room.lastBet = bigBlind;
    room.currentPlayerIndex = (bbIdx + 1) % room.players.length;
    room.waitingForAction = true;
    
    io.to(room.roomId).emit('gameMessage', '🎲 游戏开始！');
    broadcastGameState(room);
}

function nextPlayer(room) {
    if (!room.gameActive) return;
    
    let activePlayers = room.players.filter(p => !p.folded);
    if (activePlayers.length === 1) {
        let winner = activePlayers[0];
        winner.chips += room.pot;
        io.to(room.roomId).emit('gameMessage', `🏆 ${winner.name} 赢得底池 ${room.pot} 筹码！`);
        room.gameActive = false;
        broadcastGameState(room);
        return;
    }
    
    let allBetEqual = room.players.filter(p => !p.folded).every(p => p.currentBet === room.lastBet);
    if (allBetEqual) {
        advanceToNextStage(room);
        return;
    }
    
    do {
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    } while (room.players[room.currentPlayerIndex].folded);
    
    broadcastGameState(room);
}

function advanceToNextStage(room) {
    for (let p of room.players) {
        p.currentBet = 0;
    }
    room.lastBet = 0;
    
    if (room.currentRound === 'preflop') {
        if (room.deck.length >= 3) {
            room.communityCards = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
        }
        room.currentRound = 'flop';
        io.to(room.roomId).emit('gameMessage', "🔥 翻牌圈 (Flop)");
    } else if (room.currentRound === 'flop') {
        if (room.deck.length >= 1) {
            room.communityCards.push(room.deck.pop());
        }
        room.currentRound = 'turn';
        io.to(room.roomId).emit('gameMessage', "🔄 转牌圈 (Turn)");
    } else if (room.currentRound === 'turn') {
        if (room.deck.length >= 1) {
            room.communityCards.push(room.deck.pop());
        }
        room.currentRound = 'river';
        io.to(room.roomId).emit('gameMessage', "🌊 河牌圈 (River)");
    } else if (room.currentRound === 'river') {
        showdown(room);
        return;
    }
    
    let firstIdx = 0;
    for (let i = 0; i < room.players.length; i++) {
        if (!room.players[i].folded) {
            firstIdx = i;
            break;
        }
    }
    room.currentPlayerIndex = firstIdx;
    broadcastGameState(room);
}

function showdown(room) {
    let active = room.players.filter(p => !p.folded);
    if (active.length === 0) {
        room.gameActive = false;
        broadcastGameState(room);
        return;
    }
    
    active.sort((a, b) => compareHands(b.hand, a.hand, room.communityCards));
    let winner = active[0];
    winner.chips += room.pot;
    
    io.to(room.roomId).emit('gameMessage', `🏆 摊牌！${winner.name} 赢下底池 ${room.pot} 筹码！`);
    room.pot = 0;
    room.gameActive = false;
    broadcastGameState(room);
}

io.on('connection', (socket) => {
    console.log('用户连接:', socket.id);
    
    socket.on('createRoom', ({ playerName, startingChips }) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const room = createRoom(roomId, socket.id);
        room.players.push({
            id: socket.id,
            name: playerName,
            chips: startingChips,
            startingChips: startingChips,
            bet: 0,
            currentBet: 0,
            hand: [],
            folded: false
        });
        rooms.set(roomId, room);
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, playerId: socket.id });
        io.to(roomId).emit('playerJoined', { 
            players: room.players.map(p => ({ id: p.id, name: p.name }))
        });
        io.to(roomId).emit('gameMessage', `✨ ${playerName} 创建了房间，房间号: ${roomId}`);
    });
    
    socket.on('joinRoom', ({ roomId, playerName, startingChips }) => {
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('error', '❌ 房间不存在');
            return;
        }
        if (room.players.length >= 6) {
            socket.emit('error', '❌ 房间已满');
            return;
        }
        if (room.gameStarted) {
            socket.emit('error', '❌ 游戏已经开始，无法加入');
            return;
        }
        
        socket.join(roomId);
        room.players.push({
            id: socket.id,
            name: playerName,
            chips: startingChips,
            startingChips: startingChips,
            bet: 0,
            currentBet: 0,
            hand: [],
            folded: false
        });
        
        socket.emit('joinSuccess', { roomId, playerId: socket.id });
        io.to(roomId).emit('playerJoined', { 
            players: room.players.map(p => ({ id: p.id, name: p.name }))
        });
        io.to(roomId).emit('gameMessage', `🎉 ${playerName} 加入了房间 (${room.players.length}/6人)`);
        broadcastGameState(room);
    });
    
    socket.on('startGame', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('error', '房间不存在');
            return;
        }
        if (room.players.length < 2) {
            socket.emit('error', '至少需要2名玩家');
            return;
        }
        if (room.gameStarted) {
            socket.emit('error', '游戏已经开始');
            return;
        }
        if (room.hostId !== socket.id) {
            socket.emit('error', '只有房主可以开始游戏');
            return;
        }
        
        console.log(`房间 ${roomId} 开始游戏`);
        startNewHand(room);
    });
    
    socket.on('playerAction', ({ roomId, action, amount }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameActive) return;
        
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1) return;
        if (room.currentPlayerIndex !== playerIndex) return;
        if (room.players[playerIndex].folded) return;
        
        const player = room.players[playerIndex];
        
        if (action === 'fold') {
            player.folded = true;
            io.to(roomId).emit('gameMessage', `${player.name} 弃牌`);
            nextPlayer(room);
        } 
        else if (action === 'call') {
            let need = room.lastBet - player.currentBet;
            if (need > player.chips) need = player.chips;
            if (need < 0) need = 0;
            player.chips -= need;
            player.bet += need;
            player.currentBet += need;
            room.pot += need;
            io.to(roomId).emit('gameMessage', `${player.name} 跟注 ${need}`);
            nextPlayer(room);
        } 
        else if (action === 'raise' && amount) {
            let need = room.lastBet - player.currentBet;
            let total = need + amount;
            if (total > player.chips) total = player.chips;
            if (total <= need) {
                io.to(roomId).emit('gameMessage', `${player.name} 加注失败`);
                return;
            }
            let actualRaise = total - need;
            player.chips -= total;
            player.bet += total;
            player.currentBet += total;
            room.pot += total;
            room.lastBet = player.currentBet;
            room.minRaise = actualRaise;
            io.to(roomId).emit('gameMessage', `${player.name} 加注 ${actualRaise}`);
            nextPlayer(room);
        }
        
        broadcastGameState(room);
    });
    
    socket.on('disconnect', () => {
        console.log('用户断开:', socket.id);
        
        for (let [roomId, room] of rooms.entries()) {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const leftPlayer = room.players[playerIndex];
                room.players.splice(playerIndex, 1);
                
                io.to(roomId).emit('playerLeft', { 
                    players: room.players.map(p => ({ id: p.id, name: p.name }))
                });
                io.to(roomId).emit('gameMessage', `👋 ${leftPlayer.name} 离开了房间`);
                
                if (room.players.length === 0) {
                    rooms.delete(roomId);
                } else if (room.hostId === socket.id) {
                    room.hostId = room.players[0].id;
                    io.to(roomId).emit('gameMessage', `👑 ${room.players[0].name} 成为新房主`);
                }
                
                if (room.gameStarted && room.players.length < 2) {
                    room.gameActive = false;
                    room.gameStarted = false;
                    io.to(roomId).emit('gameMessage', '⚠️ 人数不足，游戏结束');
                    broadcastGameState(room);
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
