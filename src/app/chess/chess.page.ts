import { Component, OnInit, AfterViewInit, OnDestroy, ViewChild, ElementRef, computed, signal } from '@angular/core';
import { CommonModule, NgClass, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonInput, IonItem } from '@ionic/angular/standalone';
import { IonCard, IonCardContent, IonCardHeader, IonCardTitle } from '@ionic/angular/standalone';
import { Chess, Move, Square } from 'chess.js';

const PROMOTION_PIECES = ['q', 'r', 'b', 'n'] as const;
type PromotePiece = typeof PROMOTION_PIECES[number];

function squareName(r: number, c: number): string {
  const files = 'abcdefgh';
  return files[c] + (8 - r);
}

export type SquareVM = {
  name: string;
  piece?: { type: 'p' | 'r' | 'n' | 'b' | 'q' | 'k'; color: 'w' | 'b' } | null;
};

@Component({
  selector: 'app-chess',
  templateUrl: './chess.page.html',
  styleUrls: ['./chess.page.scss'],
  standalone: true,
  imports: [IonContent, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonItem, IonInput, CommonModule, FormsModule, NgFor, NgIf, NgClass],
})
export class ChessPage implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('confettiCanvas') confettiCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('board') boardEl?: ElementRef<HTMLElement>;

  game = new Chess();
  redoStack: Move[] = [];
  private confettiAnimId: number | null = null;
  private confettiUntil = 0;
  private suppressClickUntil = 0; // timestamp in ms when synthetic clicks are ignored
  // Touch/mouse drag state
  private touchDrag: { from: string; ghost: HTMLImageElement; offsetX: number; offsetY: number; startX: number; startY: number; moved: boolean; currentOverSquare?: string } | null = null;
  private boundPointerMove?: (e: PointerEvent) => void;
  private boundPointerUp?: (e: PointerEvent) => void;
  private boundTouchMove?: (e: TouchEvent) => void;
  private boundTouchEnd?: (e: TouchEvent) => void;
  private boundMouseMove?: (e: MouseEvent) => void;
  private boundMouseUp?: (e: MouseEvent) => void;
  private gameOverTimeoutId: any = null;
  // sounds
  soundOn = signal<boolean>(true);
  private audioCtx: (AudioContext | null) = null;
  private soundMap: Partial<Record<'move' | 'capture' | 'castle' | 'check' | 'gameover' | 'illegal', HTMLAudioElement>> = {};
  private audioUnlocked = false;
  private unlockAudioOnce = () => {
    try {
      const ctx = this.ensureAudio();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch { /* ignore */ }
    this.audioUnlocked = true;
  };

  // signals
  selected = signal<string | null>(null);
  lastMoveSquares = signal<Set<string>>(new Set());
  flipped = signal(false);
  // Player names (per color)
  whiteName = signal<string>('White');
  blackName = signal<string>('Black');
  // Inline edit flags (per color)
  editingWhite = signal<boolean>(false);
  editingBlack = signal<boolean>(false);
  gameOver = signal<{ reason: 'checkmate' | 'stalemate' | 'draw' | 'time'; message: string; winner: 'w' | 'b' | null } | null>(null);
  fenInput = '';
  // Time control state (default 10+0 rapid)
  baseMs = signal<number>(10 * 60 * 1000);
  incrementMs = signal<number>(0);
  whiteTimeMs = signal<number>(10 * 60 * 1000);
  blackTimeMs = signal<number>(10 * 60 * 1000);
  activeColor = signal<'w' | 'b'>('w');
  running = signal<boolean>(false);
  private timerId: any = null;
  private wasRunningBeforePromotion = false;
  timePickerOpen = signal<boolean>(false);
  // tick used to signal board state changes to computeds
  private stateTick = signal(0);
  private bumpTick() { this.stateTick.set(this.stateTick() + 1); }
  // Global cancel handlers
  private onWindowBlur = () => { this.cancelActiveDrag(); };
  private onVisibilityChange = () => { if (document.visibilityState !== 'visible') this.cancelActiveDrag(); };

  ngAfterViewInit(): void {
    this.sizeConfettiCanvas();
    window.addEventListener('resize', this.sizeConfettiCanvas);
  }

  // Cursor UX helper
  private setDraggingCursor(on: boolean) {
    const el = this.boardEl?.nativeElement;
    if (!el) return;
    if (on) el.classList.add('dragging-cursor');
    else el.classList.remove('dragging-cursor');
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.sizeConfettiCanvas);
    if (this.gameOverTimeoutId) { clearTimeout(this.gameOverTimeoutId); this.gameOverTimeoutId = null; }
    this.stopConfetti();
  }

  private sizeConfettiCanvas = () => {
    const canvas = this.confettiCanvas?.nativeElement;
    const board = this.boardEl?.nativeElement;
    if (!canvas || !board) return;
    const rect = board.getBoundingClientRect();
    canvas.width = Math.floor(rect.width);
    canvas.height = Math.floor(rect.height);
  };

  // Undo/Redo availability
  canUndo = computed<boolean>(() => { this.stateTick(); return this.game.history().length > 0; });
  canRedo = computed<boolean>(() => { this.stateTick(); return this.redoStack.length > 0; });

  // promotion state
  promotion = signal<{ ask: boolean; color: 'w' | 'b' | null; from: string | null; to: string | null }>(
    { ask: false, color: null, from: null, to: null }
  );
  promotionPieces = PROMOTION_PIECES;

  // cache legal targets for current selection
  legalTargets = computed<Set<string>>(() => {
    const from = this.selected();
    if (!from) return new Set();
    const moves = this.game.moves({ square: from as Square, verbose: true }) as Move[];
    return new Set(moves.map(m => m.to));
  });

  // cache capture targets (squares where a capture would occur) for current selection
  captureTargets = computed<Set<string>>(() => {
    const from = this.selected();
    if (!from) return new Set();
    const moves = this.game.moves({ square: from as Square, verbose: true }) as Move[];
    // chess.js verbose moves have either 'captured' defined or flags contain 'c' (capture) or 'e' (en passant)
    const caps = moves.filter(m => (m as any).captured || m.flags.includes('c') || m.flags.includes('e'));
    return new Set(caps.map(m => m.to));
  });

  // check state
  isCheck = computed<boolean>(() => { this.stateTick(); return this.game.isCheck(); });
  kingSquare = computed<string | null>(() => {
    this.stateTick();
    const color = this.game.turn();
    const b = this.game.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = b[r][c];
        if (p && p.type === 'k' && p.color === color) return squareName(r, c);
      }
    }
    return null;
  });

  // === Confetti animation (lightweight, canvas) ===
  private launchConfetti(durationMs: number = 2200) {
    const canvas = this.confettiCanvas?.nativeElement;
    if (!canvas) return;
    this.sizeConfettiCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const now = performance.now();
    this.confettiUntil = now + durationMs;
    const W = canvas.width, H = canvas.height;
    const count = Math.max(90, Math.floor((W * H) / 12000));
    const colors = ['#FFD166', '#EF476F', '#06D6A0', '#118AB2', '#8338EC', '#FF9F1C', '#2EC4B6'];
    type Piece = { x: number; y: number; r: number; vx: number; vy: number; wobble: number; wobbleSpeed: number; tilt: number; spin: number; color: string; shape: 'rect' | 'circle' | 'tri' };
    const spawn = (): Piece => {
      // Emit from the bottom, random across the full width
      const sx = Math.random() * W;
      const sy = H + 20 + Math.random() * H * 0.2;
      return {
        x: sx,
        y: sy,
        r: Math.random() * 7 + 4,
        vx: (Math.random() - 0.5) * 1.2,
        vy: -(Math.random() * 1.2 + 2.4), // upward
        wobble: Math.random() * 10,
        wobbleSpeed: 0.08 + Math.random() * 0.18,
        tilt: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.12,
        color: colors[Math.floor(Math.random() * colors.length)],
        shape: ((): Piece['shape'] => { const r = Math.random(); if (r < 0.6) return 'rect'; if (r < 0.85) return 'circle'; return 'tri'; })()
      };
    };
    const pieces: Piece[] = Array.from({ length: count }, spawn);

    const draw = (t: number) => {
      ctx.clearRect(0, 0, W, H);
      for (const p of pieces) {
        // motion & physics
        p.x += p.vx + Math.sin(p.wobble) * 0.3;
        p.y += p.vy;
        p.vy += -0.01; // buoyant upward acceleration
        p.vx *= 0.995; // air drag
        p.wobble += p.wobbleSpeed;
        p.tilt += p.spin;
        if (t < this.confettiUntil && (p.y + 10 < 0)) {
          // recycle back to bottom while active
          const np = spawn();
          p.x = np.x; p.y = np.y; p.vx = np.vx; p.vy = np.vy; p.r = np.r; p.wobble = np.wobble; p.wobbleSpeed = np.wobbleSpeed; p.tilt = np.tilt; p.spin = np.spin; p.color = np.color; p.shape = np.shape;
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.sin(p.tilt) * 0.7);
        ctx.fillStyle = p.color;
        if (p.shape === 'rect') {
          ctx.fillRect(-p.r, -p.r * 0.5, p.r * 2.1, p.r);
        } else if (p.shape === 'circle') {
          ctx.beginPath(); ctx.arc(0, 0, p.r * 0.8, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(-p.r, p.r * 0.6);
          ctx.lineTo(p.r, p.r * 0.6);
          ctx.lineTo(0, -p.r * 0.8);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }
    };

    const step = (ts: number) => {
      draw(ts);
      if (ts <= this.confettiUntil) {
        this.confettiAnimId = requestAnimationFrame(step);
      } else {
        ctx.globalAlpha = 0.94;
        draw(ts);
        ctx.globalAlpha = 1;
        this.stopConfetti();
      }
    };

    this.stopConfetti();
    this.confettiAnimId = requestAnimationFrame(step);
  }

  private stopConfetti() {
    if (this.confettiAnimId !== null) cancelAnimationFrame(this.confettiAnimId);
    this.confettiAnimId = null;
    const canvas = this.confettiCanvas?.nativeElement;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  private fileLetter(name: string): string { return name[0]; }
  private rankNumber(name: string): number { return Number(name[1]); }
  showFileLabel(name: string): boolean {
    // Show file letter on the bottom edge depending on flip state
    const targetRank = this.flipped() ? 8 : 1;
    return this.rankNumber(name) === targetRank;
  }
  showRankLabel(name: string): boolean {
    // Show rank number on the left edge depending on flip state
    const targetFile = this.flipped() ? 'h' : 'a';
    return this.fileLetter(name) === targetFile;
  }
  checkFlash = signal(false);
  private triggerCheckFlash() {
    this.checkFlash.set(true);
    setTimeout(() => this.checkFlash.set(false), 600);
  }

  // board squares in render order (respects flip)
  boardSquares = () => {
    const raw = this.game.board(); // 8x8 from 8->1 ranks
    const out: SquareVM[] = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const rr = this.flipped() ? 7 - r : r;
        const cc = this.flipped() ? 7 - c : c;
        const sqName = squareName(rr, cc);
        const piece = raw[rr][cc];
        out.push({
          name: sqName,
          piece: piece ? { type: piece.type as any, color: piece.color as any } : null,
        });
      }
    }
    return out;
  };

  // trackBy to keep square DOM stable during change detection (prevents hover flicker)
  trackSquare(index: number, sq: SquareVM) { return sq.name; }

  constructor() { }

  ngOnInit() {
    this.updateGameOverBanner();
    this.preloadSounds();
    // Unlock audio on first user gesture (Android 15+ autoplay policies)
    window.addEventListener('pointerdown', this.unlockAudioOnce, { once: true, passive: true });
    window.addEventListener('touchstart', this.unlockAudioOnce, { once: true, passive: true });
    window.addEventListener('click', this.unlockAudioOnce, { once: true, passive: true });
  }

  // === Controls ===
  reset() {
    this.game.reset();
    this.redoStack = [];
    this.selected.set(null);
    this.lastMoveSquares.set(new Set());
    this.stopConfetti();
    this.updateGameOverBanner();
    this.bumpTick();
    this.pauseClocks();
    // Reset clocks to base
    this.whiteTimeMs.set(this.baseMs());
    this.blackTimeMs.set(this.baseMs());
    this.activeColor.set('w');
  }

  undo() {
    const m = this.game.undo();
    if (m) {
      this.redoStack.push(m);
      this.selected.set(null);
      this.lastMoveSquares.set(new Set());
      this.updateGameOverBanner();
      this.bumpTick();
      if (this.soundOn()) this.playSound('move');
    }
  }

  redo() {
    const move = this.redoStack.pop();
    if (!move) return;
    const res = this.game.move(move.san);
    if (res) this.afterMoveUpdate(res);
  }

  copyFEN() {
    const text = this.game.fen();
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    }
  }

  loadFEN(fenStr: string) {
    try {
      this.game.load(fenStr);
      this.redoStack = [];
      this.selected.set(null);
      this.lastMoveSquares.set(new Set());
      this.updateGameOverBanner();
      this.bumpTick();
      // When loading a FEN, keep clocks reset
      this.pauseClocks();
      this.whiteTimeMs.set(this.baseMs());
      this.blackTimeMs.set(this.baseMs());
      this.activeColor.set('w');
    } catch {
      alert('Invalid FEN');
    }
  }

  flip() {
    this.flipped.set(!this.flipped());
  }

  // Theme toggling removed: PNG pieces are the only theme

  // === Helpers ===
  afterMoveUpdate(move: Move) {
    // new move invalidates redo history
    this.redoStack = [];
    this.selected.set(null);
    this.lastMoveSquares.set(new Set([move.from, move.to]));
    // sounds: exactly one per move, priority: gameover > check > castle > capture > move
    if (this.soundOn()) {
      const isCastle = move.flags.includes('k') || move.flags.includes('q');
      const isCapture = (move as any).captured || move.flags.includes('c') || move.flags.includes('e');
      const isMate = this.game.isCheckmate();
      const isCheck = this.game.isCheck();
      if (isMate) {
        // gameover sound is played in updateGameOverBanner(); do not play anything here
      } else if (isCheck) {
        this.playSound('check');
      } else if (isCastle) {
        this.playSound('castle');
      } else if (isCapture) {
        this.playSound('capture');
      } else {
        this.playSound('move');
      }
    }
    this.updateGameOverBanner();
    this.bumpTick();
    // Apply increment to the side that just moved
    const inc = this.incrementMs();
    if (inc > 0) {
      if (move.color === 'w') this.whiteTimeMs.set(this.whiteTimeMs() + inc);
      else this.blackTimeMs.set(this.blackTimeMs() + inc);
    }
  }

  updateGameOverBanner() {
    if (this.game.isGameOver()) {
      this.pauseClocks();
      if (this.game.isCheckmate()) {
        // Side that just moved delivered mate; current turn is loser
        const winnerColor: 'w' | 'b' = this.game.turn() === 'w' ? 'b' : 'w';
        // show animation first, then modal after 1.5s
        this.launchConfetti();
        this.playSound('gameover');
        if (this.gameOverTimeoutId) { clearTimeout(this.gameOverTimeoutId); this.gameOverTimeoutId = null; }
        this.gameOverTimeoutId = setTimeout(() => {
          this.gameOver.set({ reason: 'checkmate', message: 'by checkmate', winner: winnerColor });
          this.gameOverTimeoutId = null;
        }, 1500);
      } else if (this.game.isStalemate()) {
        this.gameOver.set({ reason: 'stalemate', message: 'by stalemate', winner: null });
      } else {
        this.gameOver.set({ reason: 'draw', message: 'draw', winner: null });
      }
    } else {
      this.gameOver.set(null);
    }
  }

  // === Time controls ===
  setTimeControl(baseMinutes: number, incSeconds: number) {
    const base = baseMinutes * 60 * 1000;
    const inc = incSeconds * 1000;
    this.baseMs.set(base);
    this.incrementMs.set(inc);
    this.whiteTimeMs.set(base);
    this.blackTimeMs.set(base);
    this.activeColor.set('w');
    this.pauseClocks();
  }

  formatTime(ms: number): string {
    const neg = ms < 0; const t = Math.max(0, ms);
    const totalSec = Math.floor(t / 1000);
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    const tenths = Math.floor((t % 1000) / 100);
    if (minutes >= 10) return `${neg ? '-' : ''}${minutes}:${seconds.toString().padStart(2, '0')}`;
    if (minutes > 0) return `${neg ? '-' : ''}${minutes}:${seconds.toString().padStart(2, '0')}`;
    return `${neg ? '-' : ''}${seconds}.${tenths}s`;
  }

  // Time preset active helper (for styling selected pill)
  isPresetActive(minutes: number, incSeconds: number): boolean {
    return this.baseMs() === minutes * 60_000 && this.incrementMs() === incSeconds * 1_000;
  }

  startClocks() {
    if (this.running()) return;
    this.running.set(true);
    const tick = () => {
      const nowTurn: 'w' | 'b' = this.game.turn();
      // Clocks should follow board turn unless paused for promotion
      if (this.promotion().ask) return; // paused during promotion
      if (nowTurn === 'w') this.whiteTimeMs.set(this.whiteTimeMs() - 100);
      else this.blackTimeMs.set(this.blackTimeMs() - 100);
      // Flag detection
      if (this.whiteTimeMs() <= 0 || this.blackTimeMs() <= 0) {
        this.onFlag();
      }
    };
    this.timerId = setInterval(tick, 100);
  }

  pauseClocks() {
    if (this.timerId) { clearInterval(this.timerId); this.timerId = null; }
    this.running.set(false);
  }

  resetClocks() {
    this.pauseClocks();
    this.whiteTimeMs.set(this.baseMs());
    this.blackTimeMs.set(this.baseMs());
    this.activeColor.set('w');
  }

  onFlag() {
    this.pauseClocks();
    const flagger = this.whiteTimeMs() <= 0 ? 'White' : 'Black';
    const winnerColor: 'w' | 'b' = flagger === 'White' ? 'b' : 'w';
    this.launchConfetti();
    this.playSound('gameover');
    if (this.gameOverTimeoutId) { clearTimeout(this.gameOverTimeoutId); this.gameOverTimeoutId = null; }
    this.gameOverTimeoutId = setTimeout(() => {
      this.gameOver.set({ reason: 'time', message: 'on time', winner: winnerColor });
      this.gameOverTimeoutId = null;
    }, 1500);
  }

  toggleTimePicker() { this.timePickerOpen.set(!this.timePickerOpen()); }

  pickPreset(minutes: number, incSeconds: number) {
    this.setTimeControl(minutes, incSeconds);
    this.timePickerOpen.set(false);
  }

  // Dismiss the game over modal manually
  dismissGameOver() {
    this.gameOver.set(null);
    if (this.gameOverTimeoutId) { clearTimeout(this.gameOverTimeoutId); this.gameOverTimeoutId = null; }
    this.stopConfetti();
  }

  // === UI helpers used by template ===
  getSquareColorClass(sq: SquareVM): string {
    const fileIndex = 'abcdefgh'.indexOf(sq.name[0]);
    const rank = Number(sq.name[1]);
    // light if file+rank is even (from white perspective)
    const light = (fileIndex + rank) % 2 === 0;
    // Use custom classes styled in chess.page.scss to match chess.com-like board theme
    return light ? 'square-light' : 'square-dark';
  }

  // Text/letters themes removed

  pieceImageSrc(sq: SquareVM): string {
    if (!sq.piece) return '';
    // Using lowercase two-letter codes like 'wp.svg', 'bk.svg'
    const code = `${sq.piece.color}${sq.piece.type}`;
    // Load PNGs placed under src/assets/pieces/cburnett/
    return `assets/pieces/cburnett/${code}.png`;
  }

  promotionImageSrc(piece: PromotePiece, color: 'w' | 'b' | null): string {
    if (!color) return '';
    const code = `${color}${piece}`; // e.g., 'wq'
    return `assets/pieces/cburnett/${code}.png`;
  }

  // No per-piece text classes; using PNGs only

  isLastMoveSquare(name: string): boolean {
    return this.lastMoveSquares().has(name);
  }

  isLegalTarget(name: string): boolean {
    return this.legalTargets().has(name);
  }

  isCaptureTarget(name: string): boolean {
    return this.captureTargets().has(name);
  }

  // Click handling and moves
  clearSelection() {
    this.selected.set(null);
    this.lastMoveSquares.set(new Set());
    this.bumpTick();
  }

  onSquareClick(name: string) {
    // Ignore synthetic clicks immediately following a drag/drop
    if (performance.now() < this.suppressClickUntil) return;
    // If a promotion choice is pending, ignore clicks on board
    if (this.promotion().ask) return;
    // Do not allow interaction if game is over
    if (this.game.isGameOver() || this.gameOver()) return;
    // Require timer to be running before allowing moves (Start must be pressed)
    if (!this.running()) return;

    const currentSel = this.selected();
    if (!currentSel) {
      // select only if piece of side to move
      const piece = this.game.get(name as any);
      if (!piece) { if (this.isCheck()) this.triggerCheckFlash(); return; } // empty square (no sound)
      if (piece.color !== this.game.turn()) { if (this.isCheck()) this.triggerCheckFlash(); this.playSound('illegal'); return; } // not your turn
      // if in check, only allow selecting pieces that have at least one legal move
      if (this.isCheck()) {
        const legal = this.game.moves({ square: name as Square, verbose: true }) as Move[];
        if (!legal.length) { this.triggerCheckFlash(); this.playSound('illegal'); return; }
      }
      this.selected.set(name);
      return;
    }

    // Toggle off if clicking the same square again
    if (currentSel === name) { this.clearSelection(); return; }

    // attempt move
    const candidates = this.game.moves({ square: currentSel as Square, verbose: true }) as Move[];
    const target = candidates.find(m => m.to === name);
    if (!target) {
      // maybe select a new piece if valid
      const piece = this.game.get(name as any);
      if (piece && piece.color === this.game.turn()) {
        if (this.isCheck()) {
          const legal = this.game.moves({ square: name as Square, verbose: true }) as Move[];
          if (!legal.length) { this.triggerCheckFlash(); this.playSound('illegal'); return; }
        }
        this.selected.set(name);
      } else {
        // Clicked elsewhere (empty or opponent piece not a legal capture) -> clear selection
        this.playSound('illegal');
        this.clearSelection();
      }
      return;
    }

    // handle promotion if needed
    if (target.flags.includes('p')) {
      // need user choice (default could be queen; but ask for UX)
      this.promotion.set({ ask: true, color: target.color as any, from: target.from, to: target.to });
      return;
    }

    const res = this.game.move({ from: target.from, to: target.to });
    if (res) this.afterMoveUpdate(res as Move);
  }

  private tryMove(from: string, to: string) {
    if (this.promotion().ask || this.game.isGameOver() || this.gameOver() || !this.running()) return;
    const candidates = this.game.moves({ square: from as Square, verbose: true }) as Move[];
    const target = candidates.find(m => m.to === to);
    if (!target) {
      // illegal drop target
      this.playSound('illegal');
      this.clearSelection();
      return;
    }
    // Handle promotion
    if (target.flags.includes('p')) {
      this.promotion.set({ ask: true, color: target.color as any, from: target.from, to: target.to });
      return;
    }
    const res = this.game.move({ from: target.from, to: target.to });
    if (res) this.afterMoveUpdate(res as Move);
  }

  // === Pointer-based touch drag (mobile) ===
  onPiecePointerDown(from: string, ev: PointerEvent) {
    // Only react to primary pointer and ignore mouse (desktop drag/click already handled)
    if (ev.button !== 0) return;
    if (ev.pointerType === 'mouse') return;
    // Disallow if promotion modal / game over
    if (this.promotion().ask || this.game.isGameOver() || this.gameOver()) return;
    const piece = this.game.get(from as any);
    if (!piece || piece.color !== this.game.turn()) {
      if (this.isCheck()) this.triggerCheckFlash();
      this.playSound('illegal');
      return;
    }
    if (this.isCheck()) {
      const legal = this.game.moves({ square: from as Square, verbose: true }) as Move[];
      if (!legal.length) { this.triggerCheckFlash(); this.playSound('illegal'); return; }
    }
    // Do not prevent default here so tap can still produce a click for click-to-move
    (ev.target as Element).dispatchEvent(new Event('blur'));
    // Create floating ghost
    const targetEl = ev.target as HTMLElement;
    const rect = targetEl.getBoundingClientRect();
    const ghost = document.createElement('img');
    ghost.id = 'touch-ghost';
    ghost.src = (targetEl as HTMLImageElement).src;
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '1000';
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = 'auto';
    ghost.style.opacity = '0.9';
    document.body.appendChild(ghost);
    const offsetX = ev.clientX - rect.left;
    const offsetY = ev.clientY - rect.top;
    ghost.style.left = `${ev.clientX - offsetX}px`;
    ghost.style.top = `${ev.clientY - offsetY}px`;
    // Mark original
    targetEl.classList.add('dragging');
    // Save state and bind listeners
    this.touchDrag = { from, ghost, offsetX, offsetY, startX: ev.clientX, startY: ev.clientY, moved: false };
    this.boundPointerMove = this.onGlobalPointerMove.bind(this);
    this.boundPointerUp = this.onGlobalPointerUp.bind(this);
    window.addEventListener('pointermove', this.boundPointerMove, { passive: false });
    window.addEventListener('pointerup', this.boundPointerUp, { passive: false });
    // Do NOT set selection yet; allow a simple tap to select via click handler.
  }

  private onGlobalPointerMove(ev: PointerEvent) {
    if (!this.touchDrag) return;
    const { ghost, offsetX, offsetY, startX, startY, from } = this.touchDrag;
    // mark as moved after a small threshold to preserve click semantics
    if (!this.touchDrag.moved) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.hypot(dx, dy) > 4) {
        this.touchDrag.moved = true;
        // Only upon actual drag start, set selection and dragging cursor
        this.selected.set(from);
        this.setDraggingCursor(true);
      }
    }
    if (this.touchDrag.moved) ev.preventDefault();
    ghost.style.left = `${ev.clientX - offsetX}px`;
    ghost.style.top = `${ev.clientY - offsetY}px`;
    // Detect square under pointer
    const sqEl = this.squareElementAtPoint(ev.clientX, ev.clientY);
    const newSq = sqEl?.getAttribute('data-square') || undefined;
    if (newSq !== this.touchDrag.currentOverSquare) {
      // update highlight class
      if (this.touchDrag.currentOverSquare) {
        const prevEl = this.getSquareElement(this.touchDrag.currentOverSquare);
        prevEl?.classList.remove('square-drop-target');
      }
      if (newSq) sqEl?.classList.add('square-drop-target');
      this.touchDrag.currentOverSquare = newSq;
    }
  }

  private onGlobalPointerUp(ev: PointerEvent) {
    if (!this.touchDrag) return;
    const { from, ghost, currentOverSquare, moved } = this.touchDrag;
    // Cleanup visuals
    ghost.remove();
    const originImg = document.querySelector(`img.piece-svg.dragging`);
    originImg?.classList.remove('dragging');
    if (currentOverSquare) this.getSquareElement(currentOverSquare)?.classList.remove('square-drop-target');
    // Unbind
    if (this.boundPointerMove) window.removeEventListener('pointermove', this.boundPointerMove as any);
    if (this.boundPointerUp) window.removeEventListener('pointerup', this.boundPointerUp as any);
    this.boundPointerMove = undefined;
    this.boundPointerUp = undefined;
    if (moved) {
      // Only treat as drag/drop if we actually moved
      ev.preventDefault();
      // Do move if over square. If released on origin square, keep selection via click
      if (currentOverSquare && currentOverSquare !== from) {
        this.tryMove(from, currentOverSquare);
        // suppress only on real drop
        this.suppressClickUntil = performance.now() + 250;
      }
    }
    this.touchDrag = null;
    this.setDraggingCursor(false);
  }

  private cancelActiveDrag() {
    if (!this.touchDrag) return;
    const { ghost, currentOverSquare } = this.touchDrag;
    try { ghost.remove(); } catch { }
    const originImg = document.querySelector(`img.piece-svg.dragging`);
    originImg?.classList.remove('dragging');
    if (currentOverSquare) this.getSquareElement(currentOverSquare)?.classList.remove('square-drop-target');
    if (this.boundPointerMove) window.removeEventListener('pointermove', this.boundPointerMove as any);
    if (this.boundPointerUp) window.removeEventListener('pointerup', this.boundPointerUp as any);
    if (this.boundMouseMove) window.removeEventListener('mousemove', this.boundMouseMove as any);
    if (this.boundMouseUp) window.removeEventListener('mouseup', this.boundMouseUp as any);
    if (this.boundTouchMove) window.removeEventListener('touchmove', this.boundTouchMove as any);
    if (this.boundTouchEnd) window.removeEventListener('touchend', this.boundTouchEnd as any);
    this.boundPointerMove = undefined;
    this.boundPointerUp = undefined;
    this.boundMouseMove = undefined;
    this.boundMouseUp = undefined;
    this.boundTouchMove = undefined;
    this.boundTouchEnd = undefined;
    this.touchDrag = null;
    this.setDraggingCursor(false);
  }

  // === Mouse-driven drag (desktop), using floating ghost, avoiding HTML5 DnD quirks ===
  onMouseDownPiece(from: string, ev: MouseEvent) {
    if (ev.button !== 0) return; // left only
    // Disallow if promotion modal / game over
    if (this.promotion().ask || this.game.isGameOver() || this.gameOver()) return;
    const piece = this.game.get(from as any);
    if (!piece || piece.color !== this.game.turn()) { if (this.isCheck()) this.triggerCheckFlash(); this.playSound('illegal'); return; }
    if (this.isCheck()) {
      const legal = this.game.moves({ square: from as Square, verbose: true }) as Move[];
      if (!legal.length) { this.triggerCheckFlash(); this.playSound('illegal'); return; }
    }
    // Do not prevent default here so click can still fire for click-to-move
    const targetEl = ev.target as HTMLElement;
    const rect = targetEl.getBoundingClientRect();
    const ghost = document.createElement('img');
    ghost.id = 'mouse-ghost';
    ghost.src = (targetEl as HTMLImageElement).src;
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '1000';
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = 'auto';
    ghost.style.opacity = '0.9';
    document.body.appendChild(ghost);
    const offsetX = ev.clientX - rect.left;
    const offsetY = ev.clientY - rect.top;
    ghost.style.left = `${ev.clientX - offsetX}px`;
    ghost.style.top = `${ev.clientY - offsetY}px`;
    targetEl.classList.add('dragging');
    this.touchDrag = { from, ghost, offsetX, offsetY, startX: ev.clientX, startY: ev.clientY, moved: false };
    this.boundMouseMove = this.onGlobalMouseMove.bind(this);
    this.boundMouseUp = this.onGlobalMouseUp.bind(this);
    window.addEventListener('mousemove', this.boundMouseMove, { passive: false });
    window.addEventListener('mouseup', this.boundMouseUp, { passive: false });
    // Defer selection/cursor until actual drag starts; allow click-to-move
  }

  private onGlobalMouseMove(ev: MouseEvent) {
    if (!this.touchDrag) return;
    const { ghost, offsetX, offsetY, startX, startY, from } = this.touchDrag;
    if (!this.touchDrag.moved) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.hypot(dx, dy) > 4) {
        this.touchDrag.moved = true;
        this.selected.set(from);
        this.setDraggingCursor(true);
      }
    }
    if (this.touchDrag.moved) ev.preventDefault();
    ghost.style.left = `${ev.clientX - offsetX}px`;
    ghost.style.top = `${ev.clientY - offsetY}px`;
    const sqEl = this.squareElementAtPoint(ev.clientX, ev.clientY);
    const newSq = sqEl?.getAttribute('data-square') || undefined;
    if (newSq !== this.touchDrag.currentOverSquare) {
      if (this.touchDrag.currentOverSquare) this.getSquareElement(this.touchDrag.currentOverSquare)?.classList.remove('square-drop-target');
      if (newSq) sqEl?.classList.add('square-drop-target');
      this.touchDrag.currentOverSquare = newSq;
    }
  }

  private onGlobalMouseUp(ev: MouseEvent) {
    if (!this.touchDrag) return;
    const { from, ghost, currentOverSquare, moved } = this.touchDrag;
    ghost.remove();
    const originImg = document.querySelector(`img.piece-svg.dragging`);
    originImg?.classList.remove('dragging');
    if (currentOverSquare) this.getSquareElement(currentOverSquare)?.classList.remove('square-drop-target');
    if (this.boundMouseMove) window.removeEventListener('mousemove', this.boundMouseMove as any);
    if (this.boundMouseUp) window.removeEventListener('mouseup', this.boundMouseUp as any);
    this.boundMouseMove = undefined;
    this.boundMouseUp = undefined;
    if (moved) {
      ev.preventDefault();
      if (currentOverSquare && currentOverSquare !== from) {
        this.tryMove(from, currentOverSquare);
        this.suppressClickUntil = performance.now() + 250;
      }
    }
    this.touchDrag = null;
  }

  // === TouchEvent-based drag (fallback for browsers where pointer events interfere with HTML5 drag) ===
  onPieceTouchStart(from: string, ev: TouchEvent) {
    if (ev.touches.length !== 1) return;
    // Disallow if promotion modal / game over
    if (this.promotion().ask || this.game.isGameOver() || this.gameOver()) return;
    const piece = this.game.get(from as any);
    if (!piece || piece.color !== this.game.turn()) { if (this.isCheck()) this.triggerCheckFlash(); if (this.soundOn()) this.playSound('illegal'); return; }
    if (this.isCheck()) {
      const legal = this.game.moves({ square: from as Square, verbose: true }) as Move[];
      if (!legal.length) { this.triggerCheckFlash(); if (this.soundOn()) this.playSound('illegal'); return; }
    }
    ev.preventDefault();
    const targetEl = ev.target as HTMLElement;
    const rect = targetEl.getBoundingClientRect();
    const ghost = document.createElement('img');
    ghost.id = 'touch-ghost';
    ghost.src = (targetEl as HTMLImageElement).src;
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '1000';
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = 'auto';
    ghost.style.opacity = '0.95';
    document.body.appendChild(ghost);
    const t = ev.touches[0];
    const offsetX = t.clientX - rect.left;
    const offsetY = t.clientY - rect.top;
    ghost.style.left = `${t.clientX - offsetX}px`;
    ghost.style.top = `${t.clientY - offsetY}px`;
    targetEl.classList.add('dragging');
    this.touchDrag = { from, ghost, offsetX, offsetY, startX: t.clientX, startY: t.clientY, moved: false };
    this.boundTouchMove = this.onGlobalTouchMove.bind(this);
    this.boundTouchEnd = this.onGlobalTouchEnd.bind(this);
    window.addEventListener('touchmove', this.boundTouchMove, { passive: false });
    window.addEventListener('touchend', this.boundTouchEnd, { passive: false });
    this.selected.set(from);
  }

  private onGlobalTouchMove(ev: TouchEvent) {
    if (!this.touchDrag) return;
    if (ev.touches.length !== 1) return;
    const { ghost, offsetX, offsetY, startX, startY } = this.touchDrag;
    const t = ev.touches[0];
    if (!this.touchDrag.moved) {
      const dx = t.clientX - startX, dy = t.clientY - startY;
      if (Math.hypot(dx, dy) > 4) this.touchDrag.moved = true;
    }
    if (this.touchDrag.moved) ev.preventDefault();
    ghost.style.left = `${t.clientX - offsetX}px`;
    ghost.style.top = `${t.clientY - offsetY}px`;
    const sqEl = this.squareElementAtPoint(t.clientX, t.clientY);
    const newSq = sqEl?.getAttribute('data-square') || undefined;
    if (newSq !== this.touchDrag.currentOverSquare) {
      if (this.touchDrag.currentOverSquare) this.getSquareElement(this.touchDrag.currentOverSquare)?.classList.remove('square-drop-target');
      if (newSq) sqEl?.classList.add('square-drop-target');
      this.touchDrag.currentOverSquare = newSq;
    }
  }

  private onGlobalTouchEnd(ev: TouchEvent) {
    if (!this.touchDrag) return;
    const { from, ghost, currentOverSquare, moved } = this.touchDrag;
    ghost.remove();
    const originImg = document.querySelector(`img.piece-svg.dragging`);
    originImg?.classList.remove('dragging');
    if (currentOverSquare) this.getSquareElement(currentOverSquare)?.classList.remove('square-drop-target');
    if (this.boundTouchMove) window.removeEventListener('touchmove', this.boundTouchMove as any);
    if (this.boundTouchEnd) window.removeEventListener('touchend', this.boundTouchEnd as any);
    this.boundTouchMove = undefined;
    this.boundTouchEnd = undefined;
    if (moved) {
      ev.preventDefault();
      if (currentOverSquare && currentOverSquare !== from) {
        this.tryMove(from, currentOverSquare);
        this.suppressClickUntil = performance.now() + 250;
      }
    }
    this.touchDrag = null;
  }

  private squareElementAtPoint(x: number, y: number): HTMLElement | null {
    let el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    return el.closest('[data-square]') as HTMLElement | null;
  }

  private getSquareElement(name: string): HTMLElement | null {
    return document.querySelector(`[data-square="${name}"]`) as HTMLElement | null;
  }

  promote(piece: PromotePiece) {
    const p = this.promotion();
    if (!p.ask || !p.from || !p.to || !p.color) return;
    const res = this.game.move({ from: p.from as any, to: p.to as any, promotion: piece });
    this.promotion.set({ ask: false, color: null, from: null, to: null });
    if (res) this.afterMoveUpdate(res as Move);
  }

  isCheckedKingSquare(name: string): boolean {
    return this.isCheck() && this.kingSquare() === name;
  }

  // === Player name editing ===
  beginEdit(color: 'w' | 'b') {
    if (color === 'w') this.editingWhite.set(true);
    else this.editingBlack.set(true);
  }

  endEdit(color: 'w' | 'b') {
    const norm = (s: string, fallback: string) => (s || '').trim() || fallback;
    if (color === 'w') {
      this.whiteName.set(norm(this.whiteName(), 'Player 1'));
      this.editingWhite.set(false);
    } else {
      this.blackName.set(norm(this.blackName(), 'Player 2'));
      this.editingBlack.set(false);
    }
  }

  winnerDisplay(): string {
    const go = this.gameOver();
    if (!go) return '';
    if (go.winner === 'w') return this.whiteName();
    if (go.winner === 'b') return this.blackName();
    return 'Draw';
  }

  toggleSound() { this.soundOn.set(!this.soundOn()); }

  private preloadSounds() {
    const base = 'assets/sounds';
    const entries: Array<[keyof typeof this.soundMap, string[]]> = [
      ['move', [`${base}/move-self.mp3`]],
      ['capture', [`${base}/capture.mp3`]],
      ['castle', [`${base}/castle.mp3`]],
      ['check', [`${base}/move-check.mp3`]],
      ['gameover', [`${base}/game-end.mp3`]],
      ['illegal', [`${base}/illegal.mp3`]],
    ];
    const canPlay = (type: string) => {
      try {
        const test = document.createElement('audio');
        return !!test.canPlayType && test.canPlayType(type) !== '';
      } catch { return false; }
    };
    const pickSrc = (candidates: string[]): string | null => {
      for (const s of candidates) {
        if (s.endsWith('.mp3') && canPlay('audio/mpeg')) return s;
      }
      return null;
    };
    for (const [k, candidates] of entries) {
      try {
        const chosen = pickSrc(candidates);
        if (!chosen) { continue; }
        const a = new Audio(chosen);
        a.preload = 'auto';
        a.volume = 1.0;
        a.muted = false;
        this.soundMap[k] = a;
      } catch { /* ignore; fallback beep will handle */ }
    }
  }

  private ensureAudio() {
    if (!this.audioCtx) {
      try {
        this.audioCtx = new (window as any).AudioContext();
      } catch { this.audioCtx = null; }
    }
    return this.audioCtx;
  }

  private playBeep(freq: number, durationMs: number, type: OscillatorType = 'sine', gain = 0.06) {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g).connect(ctx.destination);
    const now = ctx.currentTime;
    osc.start(now);
    // quick envelope to avoid clicks
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.stop(now + durationMs / 1000 + 0.02);
  }

  private playAudio(kind: 'move' | 'capture' | 'castle' | 'check' | 'gameover' | 'illegal'): boolean {
    const base = this.soundMap[kind];
    if (!base) return false;
    try {
      const a = base.cloneNode(true) as HTMLAudioElement; // allow overlapping
      a.volume = 1.0;
      a.muted = false;
      try { a.currentTime = 0; } catch { /* ignore */ }
      a.play().catch(() => { });
      return true;
    } catch { return false; }
  }

  // Haptics: safe vibrate wrapper
  private vibrate(pattern: number | number[]) {
    try {
      if ('vibrate' in navigator) (navigator as any).vibrate(pattern);
    } catch { /* ignore */ }
  }

  playSound(kind: 'move' | 'capture' | 'castle' | 'check' | 'gameover' | 'illegal') {
    // Haptics for key events regardless of sound toggle
    if (kind === 'illegal') this.vibrate(30);
    if (kind === 'gameover') this.vibrate([30, 60, 30]);

    if (!this.soundOn()) return;

    const sound = this.soundMap[kind];
    if (sound) {
      try {
        // Clone the audio element to allow overlapping sounds
        const audio = sound.cloneNode() as HTMLAudioElement;
        audio.volume = 1.0;
        audio.muted = false;
        audio.play().catch(e => console.warn('Audio play failed:', e));
        return; // Successfully played the sound
      } catch (e) {
        console.warn('Error playing sound:', e);
      }
    }

    // Fallback beeps if audio file fails or doesn't exist
    switch (kind) {
      case 'move':
        this.playBeep(540, 90, 'sine', 0.05); break;
      case 'castle':
        this.playBeep(480, 120, 'sine', 0.055); break;
      case 'capture':
        this.playBeep(320, 120, 'square', 0.06); break;
      case 'check':
        this.playBeep(740, 140, 'triangle', 0.05); break;
      case 'illegal':
        this.playBeep(220, 120, 'square', 0.06); break;
      case 'gameover':
        this.playBeep(600, 130, 'sine', 0.055);
        setTimeout(() => this.playBeep(420, 180, 'sine', 0.055), 120);
        break;
    }
  }

}