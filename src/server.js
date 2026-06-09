const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
// Serve the HTML, CSS, and asset files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

const GRID_SIZE = 10;

let gameState = {
    turn: 'player', 
    playerGrid: Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill('~')),
    opponentGrid: Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill('~')),
};

// Seed a few player ships visually so your grid isn't empty
gameState.playerGrid[1][2] = 'S'; // 2-cell Destroyer
gameState.playerGrid[1][3] = 'S'; 
gameState.playerGrid[4][4] = 'S'; // 3-cell Cruiser
gameState.playerGrid[5][4] = 'S';
gameState.playerGrid[6][4] = 'S';

// Helper: Randomly place a hidden enemy ship
function setupOpponentShips() {
    let count = 0;
    while (count < 5) {
        let r = Math.floor(Math.random() * GRID_SIZE);
        let c = Math.floor(Math.random() * GRID_SIZE);
        if (gameState.opponentGrid[r][c] === '~') {
            gameState.opponentGrid[r][c] = 'S';
            count++;
        }
    }
}
setupOpponentShips();

app.get('/api/state', (req, res) => {
    // Hide enemy ship ('S') locations from client inspect tools
    const sanitizedOpponent = gameState.opponentGrid.map(row => 
        row.map(cell => cell === 'S' ? '~' : cell)
    );
    res.json({ ...gameState, opponentGrid: sanitizedOpponent });
});

app.post('/api/fire', (req, res) => {
    const { row, col } = req.body;
    
    if (gameState.turn !== 'player') {
        return res.status(400).json({ error: "Wait for your turn!" });
    }

    // Process Player Shot
    let actualCell = gameState.opponentGrid[row][col];
    let result = 'miss';
    if (actualCell === 'S') {
        gameState.opponentGrid[row][col] = 'X';
        result = 'hit';
    } else if (actualCell === '~') {
        gameState.opponentGrid[row][col] = 'O';
    }

    gameState.turn = 'opponent';

    // Simulate Opponent firing back 1 second later
    setTimeout(() => {
        let fired = false;
        while (!fired) {
            let r = Math.floor(Math.random() * GRID_SIZE);
            let c = Math.floor(Math.random() * GRID_SIZE);
            if (gameState.playerGrid[r][c] === '~' || gameState.playerGrid[r][c] === 'S') {
                gameState.playerGrid[r][c] = gameState.playerGrid[r][c] === 'S' ? 'X' : 'O';
                fired = true;
            }
        }
        gameState.turn = 'player';
    }, 1000);

    res.json({ result });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎮 Graphical Battleship running at http://localhost:${PORT}`));