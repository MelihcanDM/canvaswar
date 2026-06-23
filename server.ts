import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = 3000; // MUST be 3000

app.use(cors());
app.use(express.json());

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 1000;
const TOTAL_PIXELS = CANVAS_WIDTH * CANVAS_HEIGHT;

const PALETTE = [
  '#FFFFFF', '#E4E4E4', '#888888', '#222222', 
  '#FFA7D1', '#E50000', '#E59500', '#A06A42', 
  '#E5D900', '#94E044', '#02BE01', '#00E5F0', 
  '#0083C7', '#0000EA', '#E04AFF', '#820080'
];

// File storage paths
const USERS_FILE = join(process.cwd(), 'users.json');
const CANVAS_FILE = join(process.cwd(), 'canvas_data.bin');
const AUTHORS_FILE = join(process.cwd(), 'canvas_authors.bin');

// Dynamic states
interface User {
  id: number;
  username: string;
  email?: string;
  passwordHash: string;
  token: string;
}

let users: User[] = [];
if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    console.log(`Loaded ${users.length} users from storage.`);
  } catch (e) {
    console.error('Error loading users.json:', e);
  }
}

let canvasData = new Uint8Array(TOTAL_PIXELS);
if (fs.existsSync(CANVAS_FILE)) {
  try {
    canvasData = new Uint8Array(fs.readFileSync(CANVAS_FILE));
    console.log('Loaded canvas data from disk.');
  } catch (e) {
    console.error('Error loading canvas_data.bin:', e);
  }
}

let pixelAuthors = new Int32Array(TOTAL_PIXELS);
pixelAuthors.fill(-1);
if (fs.existsSync(AUTHORS_FILE)) {
  try {
    const buf = fs.readFileSync(AUTHORS_FILE);
    // Align with buffer size
    const actualLength = Math.min(pixelAuthors.length, buf.byteLength / 4);
    const loadedData = new Int32Array(buf.buffer, buf.byteOffset, actualLength);
    pixelAuthors.set(loadedData);
    console.log('Loaded pixel authors from disk.');
  } catch (e) {
    console.error('Error loading canvas_authors.bin:', e);
  }
}

// Persist functions
function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save users:', e);
  }
}

function saveCanvas() {
  try {
    fs.writeFileSync(CANVAS_FILE, Buffer.from(canvasData.buffer, canvasData.byteOffset, canvasData.byteLength));
  } catch (e) {
    console.error('Failed to save canvas:', e);
  }
}

function saveAuthors() {
  try {
    fs.writeFileSync(AUTHORS_FILE, Buffer.from(pixelAuthors.buffer, pixelAuthors.byteOffset, pixelAuthors.byteLength));
  } catch (e) {
    console.error('Failed to save authors:', e);
  }
}

// Cooldown state
const cooldowns = new Map<string, number>(); // username -> timestamp
const COOLDOWN_TIME = 1 * 60 * 1000; // 1 minute in ms

const extraPixels = new Map<string, number>(); // username -> extra uses count
const adHistory = new Map<string, number[]>(); // username -> array of timestamps
const AD_COOLDOWN_MS = 1 * 60 * 1000; // 1 min
const AD_MAX_PER_DAY = 10;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Admin check helper
function isAdmin(username: string): boolean {
  return username.toLowerCase() === 'melihcandm';
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  const socketAny = socket as any;
  
  // Send current state as binary
  socket.emit('init', canvasData);

  // Authenticate user with their token
  socket.on('authenticate', ({ token }) => {
    if (!token) return;
    const user = users.find(u => u.token === token);
    if (user) {
      socketAny.userId = user.id;
      socketAny.username = user.username;
      socket.emit('authSuccess', { userId: user.id, username: user.username, token: user.token });
    } else {
      socket.emit('authError', 'Oturum geçerli değil, lütfen tekrar giriş yapın.');
    }
  });

  // User Registration
  socket.on('register', ({ username, email, password }) => {
    const cleanUsername = username?.trim();
    const cleanEmail = email?.trim()?.toLowerCase();

    if (!cleanUsername || cleanUsername.length < 3) {
      socket.emit('authError', 'Kullanıcı adı en az 3 karakter olmalıdır.');
      return;
    }
    
    if (!cleanEmail || !cleanEmail.endsWith('@gmail.com')) {
      socket.emit('authError', 'Geçerli bir Gmail adresi girmelisiniz (ornek@gmail.com).');
      return;
    }

    if (!password || password.length < 4) {
      socket.emit('authError', 'Şifre en az 4 karakter olmalıdır.');
      return;
    }

    const existing = users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
    if (existing) {
      socket.emit('authError', 'Bu kullanıcı adı zaten alınmış.');
      return;
    }

    const existingEmail = users.find(u => u.email && u.email.toLowerCase() === cleanEmail.toLowerCase());
    if (existingEmail) {
      socket.emit('authError', 'Bu Gmail adresi zaten kullanımda.');
      return;
    }

    const userId = users.length;
    const token = Buffer.from(`${cleanUsername}:${password}:${Date.now()}`).toString('base64');
    const newUser: User = {
      id: userId,
      username: cleanUsername,
      email: cleanEmail,
      passwordHash: password, // simple validation
      token
    };

    users.push(newUser);
    saveUsers();

    socketAny.userId = userId;
    socketAny.username = cleanUsername;

    socket.emit('authSuccess', { userId, username: cleanUsername, token });

    // Live update connected admins
    io.sockets.sockets.forEach((s) => {
      const sAny = s as any;
      if (sAny.username && isAdmin(sAny.username)) {
        s.emit('adminUsersList', users.map(u => ({
          id: u.id,
          username: u.username,
          email: u.email || 'Belirtilmemiş',
          password: u.passwordHash
        })));
      }
    });
  });

  // User Login
  socket.on('login', ({ username, password }) => {
    const cleanUsername = username?.trim();
    if (!cleanUsername || !password) {
      socket.emit('authError', 'Kullanıcı adı/Gmail veya şifre eksik.');
      return;
    }

    // Direct check for custom admin bypass / override
    if (cleanUsername.toLowerCase() === 'melihcandm') {
      if (password !== 'Kapılısoru1842') {
        socket.emit('authError', 'Hatalı şifre.');
        return;
      }
      
      let user = users.find(u => u.username.toLowerCase() === 'melihcandm');
      if (!user) {
        const userId = users.length;
        const token = Buffer.from(`MelihcanDM:Kapılısoru1842:${Date.now()}`).toString('base64');
        user = {
          id: userId,
          username: 'MelihcanDM',
          email: 'melihcan44344@gmail.com',
          passwordHash: 'Kapılısoru1842',
          token
        };
        users.push(user);
        saveUsers();
      }
      
      socketAny.userId = user.id;
      socketAny.username = user.username;
      socket.emit('authSuccess', { userId: user.id, username: user.username, token: user.token, isAdmin: true });
      return;
    }

    const user = users.find(u => 
      (u.username.toLowerCase() === cleanUsername.toLowerCase() || (u.email && u.email.toLowerCase() === cleanUsername.toLowerCase()))
      && u.passwordHash === password
    );
    if (!user) {
      socket.emit('authError', 'Hatalı kullanıcı adı/Gmail veya şifre.');
      return;
    }

    socketAny.userId = user.id;
    socketAny.username = user.username;

    socket.emit('authSuccess', { userId: user.id, username: user.username, token: user.token });
  });

  // Request high-fidelity pixel owner details on demand
  socket.on('getPixelInfo', ({ x, y }) => {
    if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT) {
      const index = y * CANVAS_WIDTH + x;
      const authorId = pixelAuthors[index];
      const colorIdx = canvasData[index];
      
      let creator = 'Unknown / Sistem';
      if (authorId !== -1) {
        const found = users.find(u => u.id === authorId);
        if (found) {
          creator = found.username;
        }
      }
      socket.emit('pixelInfoResponse', { x, y, colorIndex: colorIdx, author: creator });
    }
  });

  // Placement validation and broadcast
  socket.on('placePixel', ({ x, y, colorIndex, token }) => {
    let userId = socketAny.userId;
    let username = socketAny.username;

    // Fallback authentication with token
    if ((userId === undefined || username === undefined) && token) {
      const user = users.find(u => u.token === token);
      if (user) {
        userId = user.id;
        username = user.username;
        socketAny.userId = userId;
        socketAny.username = username;
      }
    }

    if (userId === undefined || username === undefined) {
      socket.emit('cooldownError', { message: 'Piksel koymak için lütfen giriş yapın veya kayıt olun!' });
      return;
    }
    
    // Check cooldown based on username (MelihcanDM bypasses cooldown completely!)
    let usedExtraPixel = false;
    if (!isAdmin(username)) {
      const ep = extraPixels.get(username) || 0;
      const lastPlaced = cooldowns.get(username) || 0;
      const now = Date.now();
      
      if (now - lastPlaced < COOLDOWN_TIME) {
        if (ep > 0) {
          extraPixels.set(username, ep - 1);
          usedExtraPixel = true;
        } else {
          socket.emit('cooldownError', { remainingMs: COOLDOWN_TIME - (now - lastPlaced) });
          return;
        }
      } else {
        cooldowns.set(username, now);
      }
    }

    // Validate bounds
    if (Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(colorIndex) &&
        x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && 
        colorIndex >= 0 && colorIndex < PALETTE.length) {
      
      const index = y * CANVAS_WIDTH + x;
      canvasData[index] = colorIndex;
      pixelAuthors[index] = userId;
      
      // Save state asynchronously
      saveCanvas();
      saveAuthors();
      
      // confirm to sender
      let nextPlacementTime: number | null = null;
      if (!isAdmin(username)) {
        const ep = extraPixels.get(username) || 0;
        if (ep > 0) {
          nextPlacementTime = null; // No UI cooldown if they have extra pixels
        } else {
          // Send actual cooldown
          nextPlacementTime = (cooldowns.get(username) || Date.now()) + COOLDOWN_TIME;
        }
      }

      socket.emit('placeConfirm', { 
        x, y, colorIndex, 
        nextPlacementTime 
      });

      // Broadcast to everyone else
      socket.broadcast.emit('pixelUpdate', { x, y, colorIndex });
    }
  });

  socket.on('adCompleted', ({ token }) => {
    let userId = socketAny.userId;
    let username = socketAny.username;

    if ((userId === undefined || username === undefined) && token) {
      const user = users.find(u => u.token === token);
      if (user) {
        userId = user.id;
        username = user.username;
        socketAny.userId = userId;
        socketAny.username = username;
      }
    }

    if (username === undefined) {
      socket.emit('adError', { message: 'Reklam ödülü için giriş yapmalısınız.' });
      return;
    }

    const now = Date.now();
    const history = adHistory.get(username) || [];
    const history24h = history.filter(time => now - time < ONE_DAY_MS);

    if (history24h.length >= AD_MAX_PER_DAY) {
      socket.emit('adError', { message: 'Günlük maksimum reklam izleme sınırına (10) ulaştınız.' });
      return;
    }

    const lastAdTime = history24h.length > 0 ? history24h[history24h.length - 1] : 0;
    if (now - lastAdTime < AD_COOLDOWN_MS) {
      socket.emit('adError', { message: 'Bir sonraki reklam için lütfen 5 dakika bekleyin.' });
      return;
    }

    // Success
    history24h.push(now);
    adHistory.set(username, history24h);

    // Reset cooldown
    cooldowns.delete(username);
    // Give +1 extra pixel
    const currentExtra = extraPixels.get(username) || 0;
    extraPixels.set(username, currentExtra + 1);

    socket.emit('adSuccess', { message: 'Tebrikler! Bekleme süreniz sıfırlandı ve ekstra +1 piksel koyma hakkı kazandınız.' });
  });

  // Admin Multiple Placement
  socket.on('placeMultiplePixels', ({ pixels, token }) => {
    let userId = socketAny.userId;
    let username = socketAny.username;

    if ((userId === undefined || username === undefined) && token) {
      const user = users.find(u => u.token === token);
      if (user) {
        userId = user.id;
        username = user.username;
        socketAny.userId = userId;
        socketAny.username = username;
      }
    }

    if (userId === undefined || username === undefined) {
      socket.emit('cooldownError', { message: 'Lütfen giriş yapın.' });
      return;
    }

    if (!isAdmin(username)) {
      socket.emit('cooldownError', { message: 'Bu işlem sadece adminler içindir.' });
      return;
    }

    if (!Array.isArray(pixels)) return;

    const updates: {x: number, y: number, colorIndex: number}[] = [];

    pixels.forEach((p) => {
      const { x, y, colorIndex } = p;
      if (Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(colorIndex) &&
          x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT && 
          colorIndex >= 0 && colorIndex < PALETTE.length) {
        
        const index = y * CANVAS_WIDTH + x;
        canvasData[index] = colorIndex;
        pixelAuthors[index] = userId;
        updates.push({ x, y, colorIndex });
      }
    });

    if (updates.length > 0) {
      saveCanvas();
      saveAuthors();
      
      socket.emit('placeMultipleConfirm', { updates });
      socket.broadcast.emit('pixelsUpdate', { updates });
    }
  });

  // Admin Clear Canvas
  socket.on('clearCanvas', ({ token }) => {
    let userId = socketAny.userId;
    let username = socketAny.username;

    if ((userId === undefined || username === undefined) && token) {
      const user = users.find(u => u.token === token);
      if (user) {
        userId = user.id;
        username = user.username;
        socketAny.userId = userId;
        socketAny.username = username;
      }
    }

    if (userId === undefined || username === undefined || !isAdmin(username)) {
      socket.emit('cooldownError', { message: 'Yetkisiz işlem.' });
      return;
    }

    // Reset canvas to white (default index 0)
    canvasData.fill(0);
    // Reset authors to 0 (no author)
    pixelAuthors.fill(0);
    
    saveCanvas();
    saveAuthors();

    // Broadcast full map initialized
    io.emit('init', canvasData);
  });

  // Admin Request Registered Users
  socket.on('getAdminUsers', ({ token }) => {
    let username = socketAny.username;
    if (username === undefined && token) {
      const user = users.find(u => u.token === token);
      if (user) {
        username = user.username;
      }
    }

    if (username === undefined || !isAdmin(username)) {
      socket.emit('adminUsersListError', { message: 'Yetkisiz erişim.' });
      return;
    }

    // Send the detailed user list to verified admin
    socket.emit('adminUsersList', users.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email || 'Belirtilmemiş',
      password: u.passwordHash
    })));
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();

