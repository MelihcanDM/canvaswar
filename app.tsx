/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { ZoomIn, ZoomOut, Maximize, AlertCircle, Check, X as XIcon, PlaySquare } from 'lucide-react';

const PALETTE = [
  '#FFFFFF', '#E4E4E4', '#888888', '#222222', 
  '#FFA7D1', '#E50000', '#E59500', '#A06A42', 
  '#E5D900', '#94E044', '#02BE01', '#00E5F0', 
  '#0083C7', '#0000EA', '#E04AFF', '#820080'
];

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 1000;

function hexToRgb(hex: string) {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) {
    return { r: 255, g: 255, b: 255 }; // Fallback to white
  }
  const bigint = parseInt(hex.slice(1), 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return { r, g, b };
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [selectedColor, setSelectedColor] = useState(3); // Default black
  const [cooldownTime, setCooldownTime] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Transform state
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const isDragging = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  
  // Game state
  const sessionId = useRef<string>('');

  // Authentication & Pixel Authorship states
  const [currentUser, setCurrentUser] = useState<{ id: number; username: string; token: string } | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authTab, setAuthTab] = useState<'login' | 'register'>('login');
  const [usernameInput, setUsernameInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState('');

  // Admin user management states
  const [adminUsers, setAdminUsers] = useState<{ id: number; username: string; email: string; password?: string }[]>([]);
  const [showAdminUsersModal, setShowAdminUsersModal] = useState(false);

  const [selectedCoordinate, setSelectedCoordinate] = useState<{ x: number; y: number } | null>(null);
  const [selectedPixelDetails, setSelectedPixelDetails] = useState<{ x: number; y: number; colorIndex: number; author: string } | null>(null);
  const [isPlacementMode, setIsPlacementMode] = useState(false);
  const [adminBrushSize, setAdminBrushSize] = useState<number>(1);

  // Ad simulation state
  const [isAdOpen, setIsAdOpen] = useState(false);
  const [adCountdown, setAdCountdown] = useState(0);

  useEffect(() => {
    let timer: number;
    if (isAdOpen && adCountdown > 0) {
      timer = window.setInterval(() => {
        setAdCountdown(prev => prev - 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isAdOpen, adCountdown]);

  const handleWatchAd = () => {
    setIsAdOpen(true);
    setAdCountdown(15);
  };

  const handleCloseAd = () => {
    if (adCountdown > 0) return;
    setIsAdOpen(false);
    
    // Tell the server we completed the ad
    if (socket && currentUser) {
      socket.emit('adCompleted', { token: currentUser.token });
    }
  };

  useEffect(() => {
    // Session ID for cooldowns
    let sid = localStorage.getItem('pixel_session');
    if (!sid) {
      sid = Math.random().toString(36).substring(2, 15);
      localStorage.setItem('pixel_session', sid);
    }
    sessionId.current = sid;

    // Load initial cooldown
    const savedCooldown = localStorage.getItem('pixel_cooldown');
    if (savedCooldown) {
      const parsed = parseInt(savedCooldown, 10);
      if (parsed > Date.now()) {
        setCooldownTime(parsed);
      } else {
        localStorage.removeItem('pixel_cooldown');
      }
    }

    // Ensure canvas displays a clean white screen immediately on load before socket init
    const initialCanvas = canvasRef.current;
    if (initialCanvas) {
      const initialCtx = initialCanvas.getContext('2d');
      if (initialCtx) {
        initialCtx.fillStyle = '#FFFFFF';
        initialCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    }

    const newSocket = io({
      transports: ['websocket', 'polling']
    });

    setSocket(newSocket);

    newSocket.on('connect', () => {
      setConnected(true);
      const savedToken = localStorage.getItem('pixel_token');
      if (savedToken) {
        newSocket.emit('authenticate', { token: savedToken });
      }
    });

    newSocket.on('disconnect', () => {
      setConnected(false);
    });

    newSocket.on('authSuccess', (userData) => {
      setCurrentUser(userData);
      localStorage.setItem('pixel_token', userData.token);
      setAuthModalOpen(false);
      setAuthError('');
      setErrorMsg('');
    });

    newSocket.on('authError', (msg) => {
      setAuthError(msg);
    });

    newSocket.on('pixelInfoResponse', (info) => {
      setSelectedPixelDetails(info);
    });

    newSocket.on('init', (data: any) => {
      let u8: Uint8Array | null = null;
      if (data instanceof Uint8Array) {
        u8 = data;
      } else if (data instanceof ArrayBuffer) {
        u8 = new Uint8Array(data);
      } else if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
        u8 = new Uint8Array(data.data);
      } else if (data && typeof data === 'object' && Array.isArray(data)) {
        u8 = new Uint8Array(data);
      } else if (data && data.buffer instanceof ArrayBuffer) {
        u8 = new Uint8Array(data.buffer);
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Fill with default white first so any missing pixels are white instead of clear/black
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      if (u8 && u8.length > 0) {
        const imgData = ctx.createImageData(CANVAS_WIDTH, CANVAS_HEIGHT);
        const len = CANVAS_WIDTH * CANVAS_HEIGHT;
        for (let i = 0; i < len; i++) {
          const colorIdx = i < u8.length ? u8[i] : 0;
          const color = hexToRgb(PALETTE[colorIdx] || '#FFFFFF');
          const dataIdx = i * 4;
          imgData.data[dataIdx] = color.r;
          imgData.data[dataIdx + 1] = color.g;
          imgData.data[dataIdx + 2] = color.b;
          imgData.data[dataIdx + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
      }
    });

    newSocket.on('pixelUpdate', ({ x, y, colorIndex }) => {
      updateCanvasPixel(x, y, colorIndex);
      
      // Keep selected details card updated reactively if someone edits the pixel under watch!
      setSelectedCoordinate(current => {
        if (current && current.x === x && current.y === y) {
          newSocket.emit('getPixelInfo', { x, y });
        }
        return current;
      });
    });

    newSocket.on('pixelsUpdate', ({ updates }) => {
      if (Array.isArray(updates)) {
        updates.forEach(({ x, y, colorIndex }) => {
          updateCanvasPixel(x, y, colorIndex);
        });
      }
    });

    newSocket.on('placeMultipleConfirm', ({ updates }) => {
      if (Array.isArray(updates)) {
        updates.forEach(({ x, y, colorIndex }) => {
          updateCanvasPixel(x, y, colorIndex);
        });
      }
      setCooldownTime(null);
      localStorage.removeItem('pixel_cooldown');
    });

    newSocket.on('placeConfirm', ({ x, y, colorIndex, nextPlacementTime }) => {
      updateCanvasPixel(x, y, colorIndex);
      if (nextPlacementTime) {
        setCooldownTime(nextPlacementTime);
        localStorage.setItem('pixel_cooldown', nextPlacementTime.toString());
      } else {
        setCooldownTime(null);
        localStorage.removeItem('pixel_cooldown');
      }
    });

    newSocket.on('cooldownError', (errObj) => {
      if (errObj.message) {
        setErrorMsg(errObj.message);
      } else {
        setErrorMsg(`Lütfen bekleyin. Cooldown aktif.`);
      }
      setTimeout(() => setErrorMsg(''), 4000);
      
      if (errObj.remainingMs) {
        const nextTime = Date.now() + errObj.remainingMs;
        setCooldownTime(nextTime);
        localStorage.setItem('pixel_cooldown', nextTime.toString());
      }
    });

    newSocket.on('adSuccess', ({ message }) => {
      setCooldownTime(null);
      localStorage.removeItem('pixel_cooldown');
      setSuccessMsg(message);
      setTimeout(() => setSuccessMsg(''), 8000);
    });

    newSocket.on('adError', ({ message }) => {
      setErrorMsg(message);
      setTimeout(() => setErrorMsg(''), 5000);
    });

    newSocket.on('adminUsersList', (list) => {
      setAdminUsers(list);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Cooldown timer
  const [timeLeft, setTimeLeft] = useState(0);
  useEffect(() => {
    if (!cooldownTime) return;
    
    const interval = setInterval(() => {
      const tl = Math.max(0, cooldownTime - Date.now());
      setTimeLeft(tl);
      if (tl === 0) {
        setCooldownTime(null);
        localStorage.removeItem('pixel_cooldown');
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownTime]);

  const updateCanvasPixel = (x: number, y: number, colorIndex: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.fillStyle = PALETTE[colorIndex];
    ctx.fillRect(x, y, 1, 1);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const coordsRef = useRef<HTMLDivElement>(null);

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDragging.current && startDistance.current === null) {
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      
      setTransform(prev => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy
      }));
      
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    } else if (isDragging.current && startDistance.current !== null) {
      // Just update lastMousePos when pinching so panning doesn't jump after pinch ends
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const clientX = e.clientX - rect.left - transform.x;
      const clientY = e.clientY - rect.top - transform.y;
      const canvasX = Math.floor(clientX / transform.scale);
      const canvasY = Math.floor(clientY / transform.scale);
      
      if (coordsRef.current) {
        if (canvasX >= 0 && canvasX < CANVAS_WIDTH && canvasY >= 0 && canvasY < CANVAS_HEIGHT) {
           coordsRef.current.textContent = `(${canvasX}, ${canvasY})`;
        } else {
           coordsRef.current.textContent = '';
        }
      }
    }
  };

  const dragStartPos = useRef({ x: 0, y: 0 });

  const handlePointerDownWithDragStart = (e: React.PointerEvent) => {
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    handlePointerDown(e);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);

    if (startDistance.current !== null) return; // Ignore if we were pinching

    const dx = e.clientX - dragStartPos.current.x;
    const dy = e.clientY - dragStartPos.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 5) return; // Ignore drag clicks

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Adjust for transform
    const clickX = e.clientX - rect.left - transform.x;
    const clickY = e.clientY - rect.top - transform.y;
    
    const canvasX = Math.floor(clickX / transform.scale);
    const canvasY = Math.floor(clickY / transform.scale);

    if (canvasX >= 0 && canvasX < CANVAS_WIDTH && canvasY >= 0 && canvasY < CANVAS_HEIGHT) {
      setSelectedCoordinate({ x: canvasX, y: canvasY });
      setSelectedPixelDetails(null); // Loading state

      // Request live details of this pixel from server
      socket?.emit('getPixelInfo', { x: canvasX, y: canvasY });
    }
  };

  const zoomToCenter = (zoomFactor: number) => {
    setTransform(prev => {
      let newScale = prev.scale * zoomFactor;
      newScale = Math.max(0.05, Math.min(newScale, 40));
      
      const container = containerRef.current;
      if (!container) return { ...prev, scale: newScale };
      
      const rect = container.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      
      const canvasX = (centerX - prev.x) / prev.scale;
      const canvasY = (centerY - prev.y) / prev.scale;
      
      const newX = centerX - canvasX * newScale;
      const newY = centerY - canvasY * newScale;
      
      return { x: newX, y: newY, scale: newScale };
    });
  };

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.2 : 0.8;
    
    setTransform(prev => {
      let newScale = prev.scale * zoomFactor;
      newScale = Math.max(0.05, Math.min(newScale, 40)); // Limits
      
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return prev;
      
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const canvasX = (mouseX - prev.x) / prev.scale;
      const canvasY = (mouseY - prev.y) / prev.scale;

      const newX = mouseX - canvasX * newScale;
      const newY = mouseY - canvasY * newScale;

      return { x: newX, y: newY, scale: newScale };
    });
  };

  const currentTransformRef = useRef(transform);
  useEffect(() => {
    currentTransformRef.current = transform;
  }, [transform]);

  const startDistance = useRef<number | null>(null);
  const startTransform = useRef<{x: number, y: number, scale: number} | null>(null);

  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      startDistance.current = Math.sqrt(dx * dx + dy * dy);
      startTransform.current = { ...currentTransformRef.current };
    }
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && startDistance.current !== null && startTransform.current !== null) {
      e.preventDefault(); // Stop default scroll/zoom
      const currDx = e.touches[0].clientX - e.touches[1].clientX;
      const currDy = e.touches[0].clientY - e.touches[1].clientY;
      const currDistance = Math.sqrt(currDx * currDx + currDy * currDy);
      
      const zoomFactor = currDistance / startDistance.current;
      
      const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      
      const mouseX = centerX - rect.left;
      const mouseY = centerY - rect.top;

      let newScale = startTransform.current.scale * zoomFactor;
      newScale = Math.max(0.05, Math.min(newScale, 40));

      const canvasX = (mouseX - startTransform.current.x) / startTransform.current.scale;
      const canvasY = (mouseY - startTransform.current.y) / startTransform.current.scale;

      const newX = mouseX - canvasX * newScale;
      const newY = mouseY - canvasY * newScale;

      setTransform({ x: newX, y: newY, scale: newScale });
    }
  };

  const handleTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) {
      startDistance.current = null;
      startTransform.current = null;
    }
  };

  // Attach non-passive wheel event AND touch events
  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.addEventListener('wheel', handleWheel, { passive: false });
      el.addEventListener('touchstart', handleTouchStart, { passive: false });
      el.addEventListener('touchmove', handleTouchMove, { passive: false });
      el.addEventListener('touchend', handleTouchEnd);
      return () => {
        el.removeEventListener('wheel', handleWheel);
        el.removeEventListener('touchstart', handleTouchStart);
        el.removeEventListener('touchmove', handleTouchMove);
        el.removeEventListener('touchend', handleTouchEnd);
      };
    }
  }, []); // Run only once

  const handleConfirmPlacement = () => {
    if (!socket || !selectedCoordinate) return;

    if (!currentUser) {
      setAuthTab('login');
      setAuthModalOpen(true);
      setErrorMsg('Lütfen piksel yerleştirmek için önce giriş yapın!');
      setTimeout(() => setErrorMsg(''), 5000);
      return;
    }

    const { x, y } = selectedCoordinate;
    const isCurrentUserAdmin = currentUser?.username?.toLowerCase() === 'melihcandm';
    
    if (isCurrentUserAdmin && adminBrushSize > 1) {
      const offset = Math.floor(adminBrushSize / 2);
      const pixels: { x: number, y: number, colorIndex: number }[] = [];
      for (let dy = 0; dy < adminBrushSize; dy++) {
        for (let dx = 0; dx < adminBrushSize; dx++) {
          const px = x - offset + dx;
          const py = y - offset + dy;
          if (px >= 0 && px < CANVAS_WIDTH && py >= 0 && py < CANVAS_HEIGHT) {
            pixels.push({ x: px, y: py, colorIndex: selectedColor });
          }
        }
      }

      socket.emit('placeMultiplePixels', {
        pixels,
        token: currentUser.token
      });

      // Optimistically draw locally
      pixels.forEach((p) => {
        updateCanvasPixel(p.x, p.y, p.colorIndex);
      });

      setSelectedPixelDetails({
        x: selectedCoordinate.x,
        y: selectedCoordinate.y,
        colorIndex: selectedColor,
        author: currentUser.username
      });

    } else {
      socket.emit('placePixel', {
        x: selectedCoordinate.x,
        y: selectedCoordinate.y,
        colorIndex: selectedColor,
        token: currentUser.token
      });

      // Optimistically draw on immediate local board for raw feedback
      updateCanvasPixel(selectedCoordinate.x, selectedCoordinate.y, selectedColor);

      // Update details locally immediately
      setSelectedPixelDetails({
        x: selectedCoordinate.x,
        y: selectedCoordinate.y,
        colorIndex: selectedColor,
        author: currentUser.username
      });
    }
    
    setIsPlacementMode(false);
  };

  const isCurrentUserAdmin = currentUser?.username?.toLowerCase() === 'melihcandm';

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept typing if auth modal is open
      if (authModalOpen) return;

      if ((e.code === 'Space' || e.code === 'Enter') && selectedCoordinate && isPlacementMode) {
        e.preventDefault();
        handleConfirmPlacement();
        return;
      }

      if (!selectedCoordinate) return;

      let { x, y } = selectedCoordinate;
      let moved = false;

      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        y = Math.max(0, y - 1);
        moved = true;
      } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        y = Math.min(CANVAS_HEIGHT - 1, y + 1);
        moved = true;
      } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        x = Math.max(0, x - 1);
        moved = true;
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        x = Math.min(CANVAS_WIDTH - 1, x + 1);
        moved = true;
      }

      if (moved) {
        e.preventDefault();
        setSelectedCoordinate({ x, y });
        setSelectedPixelDetails(null);
        socket?.emit('getPixelInfo', { x, y });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedCoordinate, socket, currentUser, selectedColor, authModalOpen]);

  const handleLogout = () => {
    setCurrentUser(null);
    localStorage.removeItem('pixel_token');
    setSelectedCoordinate(null);
    setSelectedPixelDetails(null);
    setCooldownTime(null);
    localStorage.removeItem('pixel_cooldown');
    socket?.disconnect();
    socket?.connect();
  };

  const openAuth = (tab: 'login' | 'register') => {
    setAuthTab(tab);
    setAuthError('');
    setUsernameInput('');
    setEmailInput('');
    setPasswordInput('');
    setAuthModalOpen(true);
  };

  const recenter = () => {
    const container = containerRef.current;
    if (!container) return;
    const { width, height } = container.getBoundingClientRect();
    
    const scale = Math.min(width / CANVAS_WIDTH, height / CANVAS_HEIGHT) * 0.9;
    const x = (width - CANVAS_WIDTH * scale) / 2;
    const y = (height - CANVAS_HEIGHT * scale) / 2;
    
    setTransform({ x, y, scale });
  };

  // Setup initial centering
  useEffect(() => {
    const t = setTimeout(recenter, 100);
    return () => clearTimeout(t);
  }, []);

  const formatTime = (ms: number) => {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full h-screen bg-slate-900 text-slate-100 flex flex-col font-sans overflow-hidden">
      
      {/* Header / Top Bar */}
      <div className="h-14 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-4 z-10 shrink-0">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 rounded-md bg-gradient-to-tr from-indigo-500 to-purple-500 flex flex-col justify-center items-center">
            <div className="w-4 h-4 bg-white opacity-80" />
          </div>
          <h1 className="font-bold text-lg tracking-tight text-white">Canvaswar</h1>
          <span className={`text-xs ml-4 px-2 py-0.5 rounded-full ${connected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
            {connected ? '● Online' : '○ Offline'}
          </span>
        </div>

        {/* Global Errors/Success Banner */}
        {errorMsg && (
          <div className="hidden sm:flex items-center space-x-2 text-rose-400 bg-rose-500/10 border border-rose-500/20 px-3 py-1 rounded-lg text-xs font-semibold animate-pulse absolute left-1/2 transform -translate-x-1/2">
            <AlertCircle size={14} />
            <span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div className="hidden sm:flex items-center space-x-2 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-lg text-xs font-semibold absolute left-1/2 transform -translate-x-1/2 transition-opacity">
            <Check size={14} />
            <span>{successMsg}</span>
          </div>
        )}
        
        {/* User Auth Section */}
        <div className="flex items-center space-x-3">
          {currentUser ? (
            <div className="flex items-center space-x-1.5 bg-slate-900/40 border border-slate-700/50 p-1 pr-2 rounded-lg">
              {currentUser.username.toLowerCase() === 'melihcandm' && (
                <>
                  <button 
                    onClick={(e) => {
                      const btn = e.currentTarget;
                      if (btn.innerText === 'Emin misin?') {
                        socket?.emit('clearCanvas', { token: currentUser.token });
                        btn.innerText = 'Ekranı Sıfırla';
                      } else {
                        const old = btn.innerText;
                        btn.innerText = 'Emin misin?';
                        btn.classList.add('bg-rose-600', 'text-white');
                        setTimeout(() => {
                          btn.innerText = old;
                          btn.classList.remove('bg-rose-600', 'text-white');
                        }, 3000);
                      }
                    }}
                    className="text-xs bg-rose-500/20 text-rose-300 font-bold px-2 py-1 rounded hover:bg-rose-500/30 cursor-pointer mr-2 border border-rose-500/30 transition-all"
                  >
                    Ekranı Sıfırla
                  </button>
                  <button 
                    onClick={() => {
                      socket?.emit('getAdminUsers', { token: currentUser.token });
                      setShowAdminUsersModal(true);
                    }}
                    className="text-xs bg-indigo-500/25 text-indigo-400 font-bold px-2 py-1 rounded hover:bg-indigo-500/35 cursor-pointer mr-2 border border-indigo-500/30 transition-all flex items-center space-x-1"
                  >
                    <span>👥 Kayıt Olanlar</span>
                  </button>
                </>
              )}
              <span className="text-xs bg-indigo-500/20 text-indigo-300 font-bold px-2 py-1 rounded">👤 {currentUser.username}</span>
              <button 
                onClick={handleLogout} 
                className="text-xs text-rose-400 hover:text-rose-300 bg-transparent hover:bg-rose-500/10 px-2 py-1 rounded transition-all ml-1 cursor-pointer font-medium"
              >
                Çıkış
              </button>
            </div>
          ) : (
            <div className="flex items-center space-x-2">
              <button 
                onClick={() => openAuth('login')} 
                className="text-xs font-bold bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-lg text-slate-200 hover:text-white transition-all cursor-pointer"
              >
                Giriş Yap
              </button>
              <button 
                onClick={() => openAuth('register')} 
                className="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg hover:shadow-lg hover:shadow-indigo-550/20 transition-all border border-indigo-500 cursor-pointer"
              >
                Kayıt Ol
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main Canvas Area */}
      <div 
        ref={containerRef}
        className="flex-1 relative bg-[#CCCCCC] overflow-hidden select-none cursor-crosshair touch-none"
        onPointerDown={handlePointerDownWithDragStart}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Floating Center Coordinates */}
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-30 pointer-events-none">
           <div className="bg-white text-black font-bold px-4 py-1.5 rounded-full shadow-lg text-sm tracking-wide flex items-center shadow-black/10">
             <span ref={coordsRef}></span> <span className="ml-2 text-gray-500">{transform.scale >= 1 ? Math.round(transform.scale * 10) / 10 : transform.scale.toFixed(1)}x</span>
           </div>
        </div>
        <div 
          className="absolute origin-top-left flex shadow-2xl bg-white"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
            imageRendering: 'pixelated'
          }}
        >
          <canvas 
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="w-full h-full block"
            style={{ imageRendering: 'pixelated' }}
          />
        </div>

        {/* Target Reticle Overlay (Scale Independent) */}
        {selectedCoordinate && (
          <div 
            className="absolute pointer-events-none z-20"
            style={{
              left: (selectedCoordinate.x - (isCurrentUserAdmin && isPlacementMode ? Math.floor(adminBrushSize / 2) : 0)) * transform.scale + transform.x,
              top: (selectedCoordinate.y - (isCurrentUserAdmin && isPlacementMode ? Math.floor(adminBrushSize / 2) : 0)) * transform.scale + transform.y,
              width: transform.scale * (isCurrentUserAdmin && isPlacementMode ? adminBrushSize : 1),
              height: transform.scale * (isCurrentUserAdmin && isPlacementMode ? adminBrushSize : 1),
            }}
          >
            <div className={`absolute top-0 left-0 w-1/4 h-1/4 max-w-[8px] max-h-[8px] border-t-4 border-l-4 ${isPlacementMode ? 'border-white' : 'border-white'} mix-blend-difference z-20`} />
            <div className={`absolute top-0 right-0 w-1/4 h-1/4 max-w-[8px] max-h-[8px] border-t-4 border-r-4 ${isPlacementMode ? 'border-white' : 'border-white'} mix-blend-difference z-20`} />
            <div className={`absolute bottom-0 left-0 w-1/4 h-1/4 max-w-[8px] max-h-[8px] border-b-4 border-l-4 ${isPlacementMode ? 'border-white' : 'border-white'} mix-blend-difference z-20`} />
            <div className={`absolute bottom-0 right-0 w-1/4 h-1/4 max-w-[8px] max-h-[8px] border-b-4 border-r-4 ${isPlacementMode ? 'border-white' : 'border-white'} mix-blend-difference z-20`} />
            
            {/* The white outer outline sometimes helps */}
            <div className="absolute inset-0 border border-white opacity-20 pointer-events-none" />
          </div>
        )}

        {/* Big Author Bubble */}
        {!isPlacementMode && selectedCoordinate && selectedPixelDetails && (
           <div 
             className="absolute z-30 pointer-events-none transform -translate-x-1/2 -translate-y-full pb-4"
             style={{
               left: selectedCoordinate.x * transform.scale + transform.x + transform.scale / 2,
               top: selectedCoordinate.y * transform.scale + transform.y,
             }}
           >
              <div className="bg-white text-black px-5 py-2.5 rounded-full shadow-lg whitespace-nowrap flex items-center shadow-black/20 text-xl font-medium tracking-tight">
                <span className="text-gray-700 font-bold mr-2">Yerleştiren:</span>
                <span className="font-bold">{selectedPixelDetails.author}</span>
                {/* Arrow pointing down */}
                <div className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-[8px] border-l-transparent border-t-[8px] border-t-white border-r-[8px] border-r-transparent filter drop-shadow z-[-1]" />
              </div>
           </div>
        )}

        {/* Grid overlay for high zoom */}
        {transform.scale >= 4 && (
          <div 
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `
                linear-gradient(to right, rgba(255,255,255,0.12) 1px, transparent 1px),
                linear-gradient(to bottom, rgba(255,255,255,0.12) 1px, transparent 1px)
              `,
              backgroundSize: `${transform.scale}px ${transform.scale}px`,
              backgroundPosition: `${transform.x}px ${transform.y}px`
            }}
          />
        )}

        {/* View Controls */}
        <div className="absolute right-4 top-4 flex flex-col bg-slate-800/80 backdrop-blur-md rounded-lg p-1 border border-slate-700/50 shadow-lg" style={{ pointerEvents: 'auto' }}>
          <button onClick={() => zoomToCenter(1.5)} className="p-2 hover:bg-slate-700 rounded transition-colors text-slate-300 cursor-pointer">
            <ZoomIn size={20} />
          </button>
          <button onClick={recenter} className="p-2 hover:bg-slate-700 rounded transition-colors text-slate-300 cursor-pointer">
            <Maximize size={20} />
          </button>
          <button onClick={() => zoomToCenter(1 / 1.5)} className="p-2 hover:bg-slate-700 rounded transition-colors text-slate-300 cursor-pointer">
            <ZoomOut size={20} />
          </button>
        </div>
      </div>

      {/* Bottom Panel / Overlays */}
      <div className="absolute bottom-6 left-0 right-0 flex justify-center z-30 pointer-events-none">
        {cooldownTime && !isCurrentUserAdmin && !isPlacementMode ? (
           <div className="flex gap-4">
             <div className="bg-white text-black font-bold py-2 px-6 rounded-full shadow-lg pointer-events-auto border border-gray-200 flex items-center">
                {formatTime(timeLeft)}
             </div>
             <button onClick={handleWatchAd} className="bg-amber-500 text-white font-bold py-2 px-6 rounded-full shadow-lg pointer-events-auto hover:bg-amber-600 transition border border-amber-600 flex items-center shadow-amber-500/50 cursor-pointer">
                <PlaySquare size={20} className="mr-2" /> Reklam İzle
             </button>
           </div>
        ) : (
          isPlacementMode ? (
            <div className="bg-white p-3 shadow-2xl flex flex-col items-center pointer-events-auto w-full max-w-sm mx-auto rounded-xl">
              <div className="flex flex-wrap justify-center mb-3 gap-0.5">
                {PALETTE.map((color, idx) => (
                  <button
                    key={idx}
                    className={`w-8 h-8 rounded-sm transition-transform cursor-pointer border ${selectedColor === idx ? 'border-gray-500 scale-110 shadow-md z-10' : 'border-gray-300 border-opacity-50 hover:border-gray-400'}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setSelectedColor(idx)}
                    title={`Renk ${idx}`}
                  />
                ))}
              </div>

              {isCurrentUserAdmin && (
                <div className="flex space-x-2 mb-3">
                  {[1, 3, 4, 5].map((size) => (
                    <button
                      key={size}
                      onClick={() => setAdminBrushSize(size)}
                      className={`px-3 py-1 text-sm font-bold rounded border ${adminBrushSize === size ? 'bg-indigo-500 text-white border-indigo-600' : 'bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200'}`}
                    >
                      {size}x{size}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex space-x-2 w-full">
                <button 
                  onClick={() => setIsPlacementMode(false)}
                  className="flex-1 bg-white border border-gray-300 py-2 rounded shadow-sm text-rose-500 hover:bg-gray-50 flex justify-center items-center cursor-pointer transition-colors"
                >
                  <XIcon size={24} />
                </button>
                {cooldownTime && !isCurrentUserAdmin ? (
                   <div className="flex-1 flex gap-2">
                     <div className="bg-gray-100 border border-gray-300 px-4 py-2 rounded shadow-sm text-gray-500 font-bold flex justify-center items-center pointer-events-none">
                       {formatTime(timeLeft)}
                     </div>
                     <button onClick={handleWatchAd} className="flex-1 bg-amber-500 text-white font-bold py-2 rounded shadow-sm hover:bg-amber-600 transition-colors flex justify-center items-center border border-amber-600 cursor-pointer shadow-amber-500/30">
                       <PlaySquare size={18} className="mr-1.5" /> Reklam İzle
                     </button>
                   </div>
                ) : (
                  <button 
                    onClick={handleConfirmPlacement}
                    className="flex-1 bg-white border border-gray-300 py-2 rounded shadow-sm text-emerald-500 hover:bg-gray-50 flex justify-center items-center cursor-pointer transition-colors"
                  >
                    <Check size={24} />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <button 
              onClick={() => {
                if (!currentUser) {
                  openAuth('login');
                  return;
                }
                setIsPlacementMode(true);
                if (!selectedCoordinate) {
                    setSelectedCoordinate({
                        x: Math.floor(CANVAS_WIDTH / 2),
                        y: Math.floor(CANVAS_HEIGHT / 2)
                    });
                }
              }}
              className="bg-white text-slate-800 px-6 py-2 rounded-full font-bold shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors pointer-events-auto"
            >
              Bir piksel yerleştir
            </button>
          )
        )}
      </div>

      {/* Simulation Ad Modal */}
      {isAdOpen && (
        <div className="fixed inset-0 bg-black/95 z-[60] flex flex-col items-center justify-center p-4 animate-in fade-in duration-300">
           {/* Close button that appears when countdown is 0 */}
           {adCountdown === 0 ? (
             <button onClick={handleCloseAd} className="absolute top-6 right-6 bg-white/10 hover:bg-white/20 text-white rounded-full p-3 transition-colors cursor-pointer z-50">
               <XIcon size={24} />
             </button>
           ) : (
             <div className="absolute top-6 right-6 flex items-center bg-gray-900/80 text-white px-5 py-2 rounded-full font-bold text-sm border border-gray-700/50">
               Reklamı kapat ({adCountdown})
             </div>
           )}

           <div className="max-w-3xl w-full text-center space-y-6">
             <div className="text-white/50 font-bold uppercase tracking-[0.2em] text-xs mb-8">
               Sponsorlu İçerik
             </div>
             
             <div className="w-full aspect-video bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 rounded-3xl shadow-2xl overflow-hidden flex flex-col items-center justify-center border border-white/5 p-8 space-y-6 relative group">
                {/* Decorative background elements */}
                <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-indigo-500/20 via-transparent to-transparent opacity-50" />
                
                <PlaySquare size={80} className="text-white/90 mb-4 drop-shadow-2xl opacity-80" strokeWidth={1} />
                <h2 className="text-4xl font-black text-white tracking-tight drop-shadow-md relative z-10">
                  Epic Pixel Adventures
                </h2>
                <p className="text-white/60 text-lg max-w-md relative z-10">
                  Join millions of players in the ultimate pixel art MMORPG. Download now and get 1,000 gems free!
                </p>
                <div className="mt-8 bg-amber-500 hover:bg-amber-400 transition-colors px-10 py-4 xl:py-5 rounded-full text-white font-black text-lg shadow-xl shadow-amber-500/20 cursor-wait relative z-10">
                  PLAY FOR FREE
                </div>
             </div>
             
             <div className="h-2 w-full bg-gray-800/50 rounded-full overflow-hidden mt-12 max-w-md mx-auto relative backdrop-blur-sm border border-white/5">
                <div 
                  className="h-full bg-amber-500 transition-all duration-1000 ease-linear rounded-full relative overflow-hidden" 
                  style={{ width: `${(15 - adCountdown) / 15 * 100}%` }}
                >
                  <div className="absolute inset-0 bg-white/20 w-1/2 animate-[pulse_2s_linear_infinite] skew-x-12" />
                </div>
             </div>
           </div>
        </div>
      )}

      {/* Authentication Modal */}
      {authModalOpen && (
        <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 w-full max-w-sm rounded-2xl p-6 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200">
            
            {/* Modal Closer */}
            <button 
              onClick={() => setAuthModalOpen(false)} 
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-200 cursor-pointer font-bold text-lg"
            >
              ✕
            </button>

            {/* Tab Swapping Header */}
            <div className="flex border-b border-slate-800 mb-6">
              <button 
                type="button"
                onClick={() => { setAuthTab('login'); setAuthError(''); setUsernameInput(''); setPasswordInput(''); setEmailInput(''); }}
                className={`flex-1 pb-3 text-center font-bold text-sm border-b-2 transition-all cursor-pointer ${authTab === 'login' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
              >
                Giriş Yap
              </button>
              <button 
                type="button"
                onClick={() => { setAuthTab('register'); setAuthError(''); setUsernameInput(''); setPasswordInput(''); setEmailInput(''); }}
                className={`flex-1 pb-3 text-center font-bold text-sm border-b-2 transition-all cursor-pointer ${authTab === 'register' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
              >
                Kayıt Ol
              </button>
            </div>

            <h2 className="text-lg font-bold text-white mb-4">
              {authTab === 'login' ? 'Giriş Yap' : 'Yeni Hesap Oluştur'}
            </h2>

            {authError && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs p-3 rounded-lg mb-4 flex items-center space-x-2">
                <AlertCircle size={16} className="shrink-0" />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={(e) => {
              e.preventDefault();
              if (authTab === 'login') {
                socket?.emit('login', { username: usernameInput, password: passwordInput });
              } else {
                socket?.emit('register', { username: usernameInput, email: emailInput, password: passwordInput });
              }
            }} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                  {authTab === 'login' ? 'Kullanıcı Adı veya Gmail' : 'Kullanıcı Adı'}
                </label>
                <input 
                  type="text" 
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder={authTab === 'login' ? "Melihcan veya melihcan@gmail.com" : "örn: Melihcan"}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors text-sm"
                  required
                />
              </div>

              {authTab === 'register' && (
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Gmail Adresi</label>
                  <input 
                    type="email" 
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="ornek@gmail.com"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors text-sm"
                    required
                  />
                  <p className="text-[10px] text-slate-500 mt-1">Lütfen geçerli bir @gmail.com adresi girin.</p>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Şifre</label>
                <input 
                  type="password" 
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="En az 4 karakter"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors text-sm"
                  required
                />
              </div>

              <div className="flex space-x-3 pt-3">
                <button 
                  type="button" 
                  onClick={() => setAuthModalOpen(false)}
                  className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-2 rounded-lg border border-slate-700 transition-all text-xs cursor-pointer"
                >
                  Kapat
                </button>
                <button 
                  type="submit" 
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2 rounded-lg border border-indigo-500 shadow-md shadow-indigo-500/20 transition-all text-xs cursor-pointer"
                >
                  {authTab === 'login' ? 'Giriş Yap' : 'Kayıt Ol'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Users Management Modal */}
      {showAdminUsersModal && (
        <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 w-full max-w-2xl rounded-2xl p-6 shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
            
            {/* Modal Header */}
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center space-x-2">
                  <span>👥 Kayıtlı Kullanıcılar</span>
                  <span className="text-xs bg-indigo-500/20 text-indigo-300 font-mono px-2 py-0.5 rounded-full">
                    {adminUsers.length} Toplam
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">Kayıt olan tüm kullanıcıların adı, bağlı gmail adresi ve şifresi.</p>
              </div>
              <button 
                onClick={() => setShowAdminUsersModal(false)} 
                className="text-slate-400 hover:text-slate-200 cursor-pointer font-bold text-lg p-1"
              >
                ✕
              </button>
            </div>

            {/* User Search Input */}
            <div className="mb-4">
              <input 
                type="text"
                placeholder="Kullanıcı adı veya Gmail'e göre ara..."
                id="admin-user-search"
                onChange={(e) => {
                  const val = e.target.value.toLowerCase();
                  const rows = document.querySelectorAll('.admin-user-row');
                  rows.forEach(row => {
                    const name = row.getAttribute('data-name') || '';
                    const email = row.getAttribute('data-email') || '';
                    if (name.includes(val) || email.includes(val)) {
                      row.classList.remove('hidden');
                    } else {
                      row.classList.add('hidden');
                    }
                  });
                }}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors text-sm"
              />
            </div>

            {/* Users Table */}
            <div className="overflow-y-auto flex-1 rounded-lg border border-slate-800 bg-slate-950/50">
              {adminUsers.length === 0 ? (
                <div className="py-12 text-center text-slate-500 text-sm">
                  Kayıtlı kullanıcı bulunamadı.
                </div>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                      <th className="px-4 py-3">ID</th>
                      <th className="px-4 py-3">Kullanıcı Adı</th>
                      <th className="px-4 py-3">Gmail Adresi</th>
                      <th className="px-4 py-3">Şifre</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminUsers.map((u) => (
                      <tr 
                        key={u.id} 
                        className="admin-user-row border-b border-slate-800/50 hover:bg-slate-900/40 text-slate-200 transition-colors"
                        data-name={u.username?.toLowerCase() || ''}
                        data-email={u.email?.toLowerCase() || ''}
                      >
                        <td className="px-4 py-3 font-mono text-slate-500">{u.id}</td>
                        <td className="px-4 py-3 font-semibold text-indigo-300">
                          {u.username}
                          {u.username?.toLowerCase() === 'melihcandm' && (
                            <span className="ml-1.5 text-[9px] bg-rose-500/20 text-rose-300 px-1 py-0.5 rounded font-bold uppercase tracking-wider">Admin</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-300 select-all">{u.email}</td>
                        <td className="px-4 py-3 font-mono text-amber-300 select-all font-semibold">
                          {u.password || '●●●●●●'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end pt-4 mt-2 border-t border-slate-800">
              <button 
                type="button" 
                onClick={() => setShowAdminUsersModal(false)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2 rounded-lg text-xs cursor-pointer shadow-md shadow-indigo-500/20 transition-all"
              >
                Kapat
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
