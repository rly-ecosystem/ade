
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const angleDelta = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
  const seeded = initial => {
    let seed = initial >>> 0;
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  };

  const grainradRows = ["                                                                                                    ", "                                                                                                    ", "                                                                                                    ", "                                                                                                    ", "          :::                                            :==::                                      ", "          :+=+=::                                         =====-.                                   ", "           -======-:                                      .======-                                  ", "            =========-.             :====:.            :---=*####*---------+**--:                   ", "            .===========:            :=-=---. .---=====+#%#%%#%#%--------=*#****#=-.                ", "             .-===========-:          .==+**####*======-*@%%@%@@*-------*##*###*####+               ", "               .-=============::::-++++****####+=========#%%%%%%*------*###*##*#####*+              ", "               .---===----====::::-==++++++***+==========*%%##%##*-----####*******###+              ", "              :----=---=-=-:          .===++++++=======++***#*****=----=***++++++*##+               ", "            .-----------..           .------. .::::==+++++++++++++=------===-===*=-.                ", "            ---------:.             .:::-..            .:::-=--=--------------:::                   ", "           :-::--::.                                      .-====--                                  ", "          .::-:..                                         -----:.                                   ", "          ...                                            .:-..                                      ", "                                                                                                    ", "                                                                                                    ", "                                                                                                    ", "                                                                                                    "];
  function makeField(index) {
    const field = [], ramp = ' .:-=+*#%@';
    for (let row = 0; row < grainradRows.length; row++) {
      for (let column = 0; column < grainradRows[row].length; column += 2) {
        const pair = grainradRows[row].slice(column, column + 2);
        const char = [...pair].sort((a, b) => ramp.indexOf(b) - ramp.indexOf(a))[0];
        if (!char || char === ' ') continue;
        const u = .46 - (85 - column) / 76 * 1.06, v = (row - 10.5) * .024;
        const t = clamp((.46 - u) / .78, 0, 1);
        const part = column < 31 ? 'tail' : (column > 51 && column < 65 && Math.abs(v) > .085) || (column > 34 && column < 44 && Math.abs(v) > .055) ? 'fin' : 'body';
        const shade = Math.max(0, ramp.indexOf(char)) / 9;
        field.push({ u, v, t, part, edge: Math.min(1, Math.abs(v) / .15), char,
          copper: part === 'body' && ((t > .20 && t < .39) || (t > .60 && t < .75)) && shade < .7,
          shade, phase: row * .61 + column * .39 + index });
      }
    }
    return field;
  }

  function create({ canvas, reducedMotion, onFeed } = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('RLYKoi requires a canvas.');
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('Canvas 2D is unavailable.');
    const motion = reducedMotion && typeof reducedMotion === 'object'
      ? reducedMotion : typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const isReduced = () => reducedMotion === true || !!motion?.matches;
    const starts = [[.12, .18, -.64], [.76, .12, 2.24], [.91, .67, -2.15], [.31, .82, -.91], [.08, .59, .68], [.64, .63, -2.62], [.54, .30, .97]];
    const lengths = [138, 113, 148, 124, 106, 132, 117];
    const fishes = starts.map(([nx, ny, angle], i) => ({
      index: i, nx, ny, x: 0, y: 0, angle, turn: 0,
      baseLength: lengths[i], length: lengths[i], speed: 15 + i % 3 * 3,
      baseSpeed: 15 + i % 3 * 3, phase: i * 1.713, field: makeField(i)
    }));
    let width = 0, height = 0, dpr = 1, fishCount = 6;
    let active = false, paused = false, destroyed = false;
    let theme = 'dark', monochrome = false, accent = 'ice';
    let frame = 0, previousTime = 0, previousDraw = 0, clock = 0;
    let drawCount = 0, glyphCount = 0, feedSerial = 0;
    let pointer = null, food = [];
    let lastRenderMilliseconds = 0;

    function palette() {
      if (theme === 'light') {
        return monochrome
          ? { body: ['#515a56', '#77817a', '#9aa29c'], patch: ['#414a45', '#69736c'], fin: '#77817a', eye: '#24322a', food: '#656f67' }
          : { body: ['#53615a', '#7a857b', '#a1a89b'], patch: ['#9d4b2e', '#b07442'], fin: '#879184', eye: '#263229', food: '#ad7a3d' };
      }
      return monochrome
        ? { body: ['#f2f0e8', '#dfdfd6', '#bfc8bb'], patch: ['#aab5a5', '#d4d7cb'], fin: '#c1cdbb', eye: '#39463e', food: '#d4d8c9' }
        : { body: ['#f6f1e7', '#e9e5d8', '#c9d0bc'], patch: ['#c85e3d', '#e49558'], fin: '#c1cdb6', eye: '#3b3429', food: '#dfb66e' };
    }

    function bend(fish, t) {
      const amplitude = (.003 + .020 * t ** 1.7) * fish.length;
      return Math.sin(fish.phase - t * TAU * .93) * amplitude;
    }

    function drawFish(fish, colors) {
      const length = fish.length;
      context.save();
      context.translate(fish.x, fish.y);
      context.rotate(fish.angle);
      context.font = `500 ${(length / 130 * 4.2).toFixed(2)}px "SFMono-Regular",Menlo,Consolas,monospace`;
      const rootBend = bend(fish, 1);
      const tailAngle = Math.sin(fish.phase - TAU * .93) * .27 - fish.turn * .15;
      const tailCos = Math.cos(tailAngle), tailSin = Math.sin(tailAngle);
      for (const glyph of fish.field) {
        let x = glyph.u * length, y = glyph.v * length;
        if (glyph.part === 'tail') {
          const dx = x + .32 * length;
          const opening = .87 + .13 * Math.sin(fish.phase - .5);
          y *= opening;
          x = -.32 * length + dx * tailCos - y * tailSin;
          y = rootBend + dx * tailSin + y * tailCos;
        } else if (glyph.part === 'fin') {
          const side = Math.sign(glyph.v);
          const angle = side * (.05 + .17 * Math.sin(fish.phase * 1.17 + side * .65));
          const dx = x - .11 * length, dy = y - side * .09 * length;
          x = .11 * length + dx * Math.cos(angle) - dy * Math.sin(angle);
          y = side * .09 * length + dx * Math.sin(angle) + dy * Math.cos(angle) + bend(fish, .38);
        } else {
          const t = glyph.t;
          const slope = (bend(fish, Math.min(1, t + .015)) - bend(fish, Math.max(0, t - .015))) / (-.0234 * length);
          x -= y * Math.sin(Math.atan(slope));
          y = bend(fish, t) + y * Math.cos(Math.atan(slope));
        }

        if (glyph.part === 'eye') {
          context.fillStyle = colors.eye;
          context.globalAlpha = .96;
        } else if (glyph.part === 'fin' || glyph.part === 'tail') {
          context.fillStyle = colors.fin;
          context.globalAlpha = .58 + glyph.shade * .21 - glyph.edge * .025;
        } else {
          context.fillStyle = glyph.copper ? colors.patch[glyph.shade > .48 ? 1 : 0] : colors.body[glyph.edge > .77 ? 2 : glyph.shade > .72 ? 1 : 0];
          context.globalAlpha = clamp(.92 + glyph.shade * .065 - glyph.edge * .025 + Math.sin(clock * .7 + glyph.phase) * .012, .88, .99);
        }
        context.fillText(glyph.char, x, y);
        glyphCount++;
      }
      context.restore();
    }

    function draw() {
      if (destroyed || !width || !height) return;
      const started = performance.now();
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      glyphCount = 0;
      const colors = palette();
      for (let i = 0; i < fishCount; i++) drawFish(fishes[i], colors);
      context.font = '8px "SFMono-Regular",Menlo,Consolas,monospace';
      context.fillStyle = colors.food;
      for (const bit of food) {
        context.globalAlpha = clamp(bit.life / 2, 0, .82);
        context.fillText(bit.char, bit.x, bit.y);
        glyphCount++;
      }
      context.globalAlpha = 1;
      drawCount++;
      lastRenderMilliseconds = performance.now() - started;
    }

    function advance(dt) {
      clock += dt;
      food = food.filter(bit => (bit.life -= dt) > 0);
      for (let i = 0; i < fishCount; i++) {
        const fish = fishes[i];
        const wander = fish.angle + Math.sin(clock * .21 + i * 2.7) * .66 + Math.sin(clock * .071 + i) * .22;
        let fx = Math.cos(wander), fy = Math.sin(wander);
        const wall = Math.min(fish.length * .87, Math.min(width, height) * .36);
        fx += 3.4 * Math.max(0, (wall - fish.x) / wall) ** 2 - 3.4 * Math.max(0, (wall - (width - fish.x)) / wall) ** 2;
        fy += 3.4 * Math.max(0, (wall - fish.y) / wall) ** 2 - 3.4 * Math.max(0, (wall - (height - fish.y)) / wall) ** 2;

        let closest = null, closestDistance = Infinity;
        const headX = fish.x + Math.cos(fish.angle) * fish.length * .37;
        const headY = fish.y + Math.sin(fish.angle) * fish.length * .37;
        for (const bit of food) {
          const distance = Math.hypot(bit.x - headX, bit.y - headY);
          if (distance < closestDistance) { closest = bit; closestDistance = distance; }
        }
        if (closest) {
          const dx = closest.x - fish.x, dy = closest.y - fish.y, distance = Math.hypot(dx, dy) || 1;
          fx += dx / distance * 1.8;
          fy += dy / distance * 1.8;
          if (closestDistance < 16) closest.life = 0;
        }

        if (pointer) {
          const dx = fish.x - pointer.x, dy = fish.y - pointer.y, distance = Math.hypot(dx, dy);
          if (distance > 1 && distance < 105) {
            const strength = (1 - distance / 105) ** 2 * .85;
            fx += dx / distance * strength;
            fy += dy / distance * strength;
          }
        }

        for (let j = 0; j < fishCount; j++) {
          if (i === j) continue;
          const other = fishes[j], dx = fish.x - other.x, dy = fish.y - other.y;
          const distance = Math.hypot(dx, dy), separation = (fish.length + other.length) * .32;
          if (distance > .01 && distance < separation) {
            const strength = (1 - distance / separation) * 1.2;
            fx += dx / distance * strength;
            fy += dy / distance * strength;
          }
        }

        const desiredTurn = clamp(angleDelta(Math.atan2(fy, fx) - fish.angle) * 1.55, -.93, .93);
        fish.turn += (desiredTurn - fish.turn) * (1 - Math.exp(-dt * 3.4));
        fish.angle += fish.turn * dt;
        const edgeDistance = Math.min(fish.x, width - fish.x, fish.y, height - fish.y);
        const edgeSpeed = .35 + .65 * clamp(edgeDistance / (fish.length * .65), 0, 1);
        const desiredSpeed = fish.baseSpeed * (closest ? 1.24 : 1) * (1 + Math.sin(clock * .8 + i * 1.7) * .10) * edgeSpeed;
        fish.speed += (desiredSpeed - fish.speed) * (1 - Math.exp(-dt * 1.3));
        fish.x += Math.cos(fish.angle) * fish.speed * dt;
        fish.y += Math.sin(fish.angle) * fish.speed * dt;
        fish.phase += dt * (2.1 + fish.speed * .055 + i * .035);
      }
    }

    function shouldRun() { return active && !paused && !isReduced() && !destroyed; }
    function tick(time) {
      frame = 0;
      if (!shouldRun()) return;
      if (!previousDraw || time - previousDraw >= 1000 / 30 - 1) {
        const dt = previousTime ? Math.min((time - previousTime) / 1000, .10) : 0;
        previousTime = time;
        previousDraw = time;
        advance(dt);
        draw();
      }
      if (shouldRun()) frame = requestAnimationFrame(tick);
    }
    function sync() {
      if (!shouldRun()) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        previousTime = previousDraw = 0;
      } else if (!frame) {
        previousTime = previousDraw = 0;
        frame = requestAnimationFrame(tick);
      }
    }
    function resize() {
      if (destroyed) return;
      const rect = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, rect.width || canvas.clientWidth || 1);
      const nextHeight = Math.max(1, rect.height || canvas.clientHeight || 1);
      const nextDpr = clamp(globalThis.devicePixelRatio || 1, 1, 2);
      if (width === nextWidth && height === nextHeight && nextDpr === dpr) return;
      const oldWidth = width, oldHeight = height;
      width = nextWidth; height = nextHeight; dpr = nextDpr;
      fishCount = width < 580 ? 5 : width > 1180 ? 7 : 6;
      const sizeScale = clamp(Math.min(width / 700, height / 570), .72, 1.06);
      for (const fish of fishes) {
        fish.x = oldWidth ? fish.x * width / oldWidth : fish.nx * width;
        fish.y = oldHeight ? fish.y * height / oldHeight : fish.ny * height;
        fish.length = fish.baseLength * sizeScale;
      }
      for (const bit of food) {
        bit.x = oldWidth ? bit.x * width / oldWidth : bit.x;
        bit.y = oldHeight ? bit.y * height / oldHeight : bit.y;
      }
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      draw();
    }
    function feed(x, y) {
      if (destroyed || !active || paused || isReduced() || !Number.isFinite(x) || !Number.isFinite(y)) return false;
      const random = seeded(0xf33d + ++feedSerial * 613);
      const centerX = clamp(x, 16, width - 16), centerY = clamp(y, 16, height - 16);
      food = food.filter(bit => bit.life > 0).slice(-10);
      for (let i = 0; i < 9; i++) {
        const angle = random() * TAU, radius = 3 + random() * 17;
        food.push({ x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius, life: 7 + random() * 3, char: i % 3 ? '.' : ':' });
      }
      if (typeof onFeed === 'function') onFeed({ x: centerX, y: centerY, count: food.length });
      return true;
    }
    function motionChanged() { sync(); draw(); }
    motion?.addEventListener?.('change', motionChanged);
    resize();

    return {
      setAppearance(next = {}) {
        if (destroyed) return;
        if (next.theme === 'dark' || next.theme === 'light') theme = next.theme;
        if (typeof next.accent === 'string') accent = next.accent;
        if (typeof next.monochrome === 'boolean') monochrome = next.monochrome;
        draw();
      },
      setActive(value) { active = !!value; sync(); },
      setPaused(value) { paused = !!value; sync(); },
      setPointer(x, y) { pointer = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null; },
      resize,
      feed,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        sync();
        motion?.removeEventListener?.('change', motionChanged);
        food = []; pointer = null;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
      },
      debugSnapshot() {
        const visible = fishes.slice(0, fishCount);
        return {
          frame: drawCount, frames: drawCount, glyphCount, glyphBudget: 3500,
          width, height, dpr, fishCount, active, paused, reducedMotion: isReduced(),
          pendingFrame: !!frame, foodCount: food.filter(bit => bit.life > 0).length,
          theme, accent, monochrome, lastRenderMilliseconds,
          finite: visible.every(fish => [fish.x, fish.y, fish.angle, fish.length, fish.phase].every(Number.isFinite)),
          fish: visible.map(fish => ({ id: fish.index, x: fish.x, y: fish.y, angle: fish.angle, length: fish.length, glyphs: fish.field.length }))
        };
      }
    };
  }

  globalThis.RLYKoi = { create };
})();
