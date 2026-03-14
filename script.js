/*  ============================================================
    Handboard — Air Drawing with Hand Tracking (MediaPipe Hands)
    ============================================================ */

(function () {
  "use strict";

  // ─── DOM refs ───
  const video         = document.getElementById("webcam");
  const webcamCanvas  = document.getElementById("webcamCanvas");
  const drawingCanvas = document.getElementById("drawingCanvas");
  const fingerCursor  = document.getElementById("fingerCursor");
  const statusDot     = document.getElementById("statusDot");
  const statusText    = document.getElementById("statusText");
  const loadingOverlay= document.getElementById("loadingOverlay");

  const colorPicker   = document.getElementById("colorPicker");
  const colorWrapper  = document.getElementById("colorWrapper");
  const brushSlider   = document.getElementById("brushSize");
  const brushLabel    = document.getElementById("brushLabel");
  const btnEraser     = document.getElementById("btnEraser");
  const btnMove       = document.getElementById("btnMove");
  const btnGrab       = document.getElementById("btnGrab");
  const btnUndo       = document.getElementById("btnUndo");
  const btnClear      = document.getElementById("btnClear");

  const wcCtx = webcamCanvas.getContext("2d");
  const dwCtx = drawingCanvas.getContext("2d");

  // ─── State ───
  let currentColor = colorPicker.value;
  let brushSize    = parseInt(brushSlider.value, 10);
  let eraserMode   = false;
  let moveMode     = false;
  let grabMode     = false;
  let isDrawing    = false;

  // Grab state
  let grabbedStroke  = null;   // reference to the stroke being dragged
  let grabPrevPoint  = null;   // previous finger position for delta calc

  // Strokes: array of { points: [{x,y}], color, size }
  let strokes      = [];
  let currentStroke = null;

  // Canvas offset for move mode
  let canvasOffsetX = 0;
  let canvasOffsetY = 0;
  let movePrevPoint = null;

  // Smoothing: previous point for line interpolation
  let prevPoint = null;

  // ─── Helpers: resize canvases to viewport ───
  function resizeCanvases() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    webcamCanvas.width  = w;  webcamCanvas.height  = h;
    drawingCanvas.width = w;  drawingCanvas.height = h;
    redrawAllStrokes();
  }
  window.addEventListener("resize", resizeCanvases);
  resizeCanvases();

  // ─── Color picker sync ───
  colorPicker.addEventListener("input", (e) => {
    currentColor = e.target.value;
    colorWrapper.style.borderColor = currentColor;
    if (eraserMode) toggleEraser(); // exit eraser
  });
  colorWrapper.style.borderColor = currentColor;

  // ─── Brush size ───
  brushSlider.addEventListener("input", (e) => {
    brushSize = parseInt(e.target.value, 10);
    brushLabel.textContent = brushSize;
  });

  // ─── Eraser toggle ───
  function toggleEraser() {
    eraserMode = !eraserMode;
    btnEraser.classList.toggle("active", eraserMode);
    if (eraserMode && moveMode) toggleMove();
    if (eraserMode && grabMode) toggleGrab();
  }
  btnEraser.addEventListener("click", toggleEraser);

  // ─── Move toggle ───
  function toggleMove() {
    moveMode = !moveMode;
    btnMove.classList.toggle("active", moveMode);
    if (moveMode && eraserMode) toggleEraser();
    if (moveMode && grabMode) toggleGrab();
  }
  btnMove.addEventListener("click", toggleMove);

  // ─── Grab toggle ───
  function toggleGrab() {
    grabMode = !grabMode;
    btnGrab.classList.toggle("active", grabMode);
    if (grabMode && eraserMode) toggleEraser();
    if (grabMode && moveMode) toggleMove();
    if (!grabMode) { grabbedStroke = null; grabPrevPoint = null; }
  }
  btnGrab.addEventListener("click", toggleGrab);

  // ─── Undo ───
  function undo() {
    if (strokes.length === 0) return;
    strokes.pop();
    redrawAllStrokes();
  }
  btnUndo.addEventListener("click", undo);

  // ─── Clear ───
  function clearAll() {
    strokes = [];
    canvasOffsetX = 0;
    canvasOffsetY = 0;
    redrawAllStrokes();
  }
  btnClear.addEventListener("click", clearAll);

  // ─── Keyboard shortcuts ───
  document.addEventListener("keydown", (e) => {
    if (e.key === "e" || e.key === "E") toggleEraser();
    if (e.key === "m" || e.key === "M") toggleMove();
    if (e.key === "g" || e.key === "G") toggleGrab();
    if (e.key === "c" || e.key === "C") clearAll();
    if (e.ctrlKey && e.key === "z") { e.preventDefault(); undo(); }
  });

  // ─── Drawing helpers ───
  function drawSingleStroke(ctx, stroke, highlight) {
    if (stroke.points.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth   = stroke.size;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    if (highlight) {
      ctx.shadowColor = "#ffaa00";
      ctx.shadowBlur  = 14;
    }
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      const prev = stroke.points[i - 1];
      const curr = stroke.points[i];
      const mx = (prev.x + curr.x) / 2;
      const my = (prev.y + curr.y) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
    }
    ctx.stroke();
    if (highlight) {
      ctx.shadowColor = "transparent";
      ctx.shadowBlur  = 0;
    }
  }

  function redrawAllStrokes() {
    dwCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    dwCtx.save();
    dwCtx.translate(canvasOffsetX, canvasOffsetY);
    for (const stroke of strokes) {
      const isGrabbed = grabMode && stroke === grabbedStroke;
      drawSingleStroke(dwCtx, stroke, isGrabbed);
    }
    dwCtx.restore();
  }

  // ─── Find nearest stroke to a point ───
  function findNearestStroke(px, py, maxDist) {
    const ax = px - canvasOffsetX;
    const ay = py - canvasOffsetY;
    let best = null;
    let bestDist = maxDist;

    for (const stroke of strokes) {
      for (const p of stroke.points) {
        const d = Math.sqrt((p.x - ax) ** 2 + (p.y - ay) ** 2);
        if (d < bestDist) {
          bestDist = d;
          best = stroke;
        }
      }
    }
    return best;
  }

  function eraseNear(x, y, radius) {
    // Remove points close to eraser; if a stroke becomes empty, remove it
    const r2 = radius * radius;
    const ax = x - canvasOffsetX;
    const ay = y - canvasOffsetY;
    let changed = false;

    strokes = strokes.filter((stroke) => {
      const before = stroke.points.length;
      stroke.points = stroke.points.filter(
        (p) => (p.x - ax) ** 2 + (p.y - ay) ** 2 > r2
      );
      if (stroke.points.length !== before) changed = true;
      return stroke.points.length > 1;
    });

    if (changed) redrawAllStrokes();
  }

  // ─── Finger detection helpers ───
  // MediaPipe hand landmarks indices:
  //  0: WRIST
  //  4: THUMB_TIP,  3: THUMB_IP,  2: THUMB_MCP
  //  8: INDEX_TIP,  7: INDEX_DIP, 6: INDEX_PIP, 5: INDEX_MCP
  // 12: MIDDLE_TIP, 11: MIDDLE_DIP
  // 16: RING_TIP,   15: RING_DIP
  // 20: PINKY_TIP,  19: PINKY_DIP

  function isFingerExtended(landmarks, tipIdx, dipIdx) {
    // A finger is extended if its tip is above (lower y) its DIP joint
    return landmarks[tipIdx].y < landmarks[dipIdx].y;
  }

  function isThumbExtended(landmarks) {
    // Thumb: compare tip.x vs IP.x relative to wrist side
    const wrist = landmarks[0];
    const tip   = landmarks[4];
    const ip    = landmarks[3];
    // Determine hand orientation
    const isRightHand = landmarks[5].x < landmarks[17].x;
    if (isRightHand) {
      return tip.x < ip.x; // thumb points left
    } else {
      return tip.x > ip.x; // thumb points right
    }
  }

  function countExtendedFingers(landmarks) {
    let count = 0;
    if (isThumbExtended(landmarks))                     count++;
    if (isFingerExtended(landmarks, 8, 6))   count++; // index
    if (isFingerExtended(landmarks, 12, 10)) count++; // middle
    if (isFingerExtended(landmarks, 16, 14)) count++; // ring
    if (isFingerExtended(landmarks, 20, 18)) count++; // pinky
    return count;
  }

  function isOnlyIndexExtended(landmarks) {
    return (
      isFingerExtended(landmarks, 8, 6) &&            // index up
      !isFingerExtended(landmarks, 12, 10) &&          // middle down
      !isFingerExtended(landmarks, 16, 14) &&          // ring down
      !isFingerExtended(landmarks, 20, 18)             // pinky down
    );
  }

  function isIndexAndMiddleExtended(landmarks) {
    return (
      isFingerExtended(landmarks, 8, 6) &&
      isFingerExtended(landmarks, 12, 10) &&
      !isFingerExtended(landmarks, 16, 14) &&
      !isFingerExtended(landmarks, 20, 18)
    );
  }

  function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  // ─── Status helpers ───
  function setStatus(state, text) {
    statusDot.className = "status-dot " + state;
    statusText.textContent = text;
  }

  function setCursor(x, y, state) {
    fingerCursor.style.left = x + "px";
    fingerCursor.style.top  = y + "px";
    fingerCursor.style.display = "block";
    fingerCursor.className = "finger-cursor " + state;
    // Scale cursor to brush size
    if (state === "drawing" || state === "") {
      const s = Math.max(brushSize * 2, 14);
      fingerCursor.style.width  = s + "px";
      fingerCursor.style.height = s + "px";
    }
  }

  function hideCursor() {
    fingerCursor.style.display = "none";
  }

  // ─── MediaPipe Hands setup ───
  const hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6,
  });

  hands.onResults(onResults);

  // ─── Process results ───
  function onResults(results) {
    const w = webcamCanvas.width;
    const h = webcamCanvas.height;

    // Draw mirrored webcam feed faintly
    wcCtx.save();
    wcCtx.clearRect(0, 0, w, h);
    wcCtx.translate(w, 0);
    wcCtx.scale(-1, 1);
    wcCtx.drawImage(results.image, 0, 0, w, h);
    wcCtx.restore();

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      // No hand detected
      setStatus("no-hand", "No hand detected");
      hideCursor();
      finishStroke();
      movePrevPoint = null;
      grabPrevPoint = null;
      return;
    }

    const landmarks = results.multiHandLandmarks[0];

    // Index fingertip in pixel coords (mirrored)
    const indexTip = landmarks[8];
    const px = (1 - indexTip.x) * w; // mirror
    const py = indexTip.y * h;

    const extendedCount = countExtendedFingers(landmarks);
    const onlyIndex     = isOnlyIndexExtended(landmarks);
    const twoFingers    = isIndexAndMiddleExtended(landmarks);

    // ─── GRAB MODE ───
    if (grabMode) {
      if (onlyIndex) {
        // If no stroke grabbed yet, find one near fingertip
        if (!grabbedStroke) {
          grabbedStroke = findNearestStroke(px, py, 40);
          grabPrevPoint = { x: px, y: py };
          if (grabbedStroke) {
            redrawAllStrokes(); // show highlight
          }
        }

        if (grabbedStroke) {
          // Drag the grabbed stroke
          setCursor(px, py, "grabbing");
          setStatus("moving", "Grabbing stroke ✊");
          if (grabPrevPoint) {
            const dx = px - grabPrevPoint.x;
            const dy = py - grabPrevPoint.y;
            for (const p of grabbedStroke.points) {
              p.x += dx;
              p.y += dy;
            }
            redrawAllStrokes();
          }
          grabPrevPoint = { x: px, y: py };
        } else {
          setCursor(px, py, "grab-idle");
          setStatus("idle", "Point near a stroke to grab it");
          grabPrevPoint = null;
        }
      } else {
        // Open hand or other gesture → release
        if (grabbedStroke) {
          grabbedStroke = null;
          grabPrevPoint = null;
          redrawAllStrokes(); // remove highlight
        }
        setCursor(px, py, "grab-idle");
        setStatus("idle", "Stroke released · Point to grab");
        grabPrevPoint = null;
      }
      finishStroke();
      return;
    }

    // ─── MOVE MODE ───
    if (moveMode) {
      setCursor(px, py, "");
      if (onlyIndex) {
        setStatus("moving", "Moving canvas");
        if (movePrevPoint) {
          canvasOffsetX += px - movePrevPoint.x;
          canvasOffsetY += py - movePrevPoint.y;
          redrawAllStrokes();
        }
        movePrevPoint = { x: px, y: py };
      } else {
        setStatus("idle", "Open hand to stop · Point to move");
        movePrevPoint = null;
      }
      finishStroke();
      return;
    }

    // ─── ERASER MODE ───
    if (eraserMode) {
      if (onlyIndex || twoFingers) {
        setCursor(px, py, "erasing");
        setStatus("erasing", "Erasing");
        eraseNear(px, py, 22);
      } else {
        setCursor(px, py, "");
        setStatus("idle", "Point finger to erase");
      }
      finishStroke();
      return;
    }

    // ─── DRAWING MODE ───
    if (onlyIndex) {
      // Draw
      setCursor(px, py, "drawing");
      setStatus("drawing", "Drawing ✏️");

      // Convert to canvas coords (subtract offset for storage)
      const cx = px - canvasOffsetX;
      const cy = py - canvasOffsetY;

      if (!isDrawing) {
        // Start a new stroke
        currentStroke = { points: [{ x: cx, y: cy }], color: currentColor, size: brushSize };
        strokes.push(currentStroke);
        isDrawing = true;
        prevPoint = { x: px, y: py };
      } else {
        // Continue stroke
        currentStroke.points.push({ x: cx, y: cy });

        // Live draw segment for smoothness
        dwCtx.save();
        dwCtx.translate(canvasOffsetX, canvasOffsetY);
        dwCtx.beginPath();
        dwCtx.strokeStyle = currentColor;
        dwCtx.lineWidth   = brushSize;
        dwCtx.lineCap     = "round";
        dwCtx.lineJoin    = "round";
        const pts = currentStroke.points;
        if (pts.length >= 2) {
          const p1 = pts[pts.length - 2];
          const p2 = pts[pts.length - 1];
          const mx = (p1.x + p2.x) / 2;
          const my = (p1.y + p2.y) / 2;
          dwCtx.moveTo(p1.x, p1.y);
          dwCtx.quadraticCurveTo(p1.x, p1.y, mx, my);
        }
        dwCtx.stroke();
        dwCtx.restore();

        prevPoint = { x: px, y: py };
      }
    } else if (extendedCount >= 4) {
      // Open hand → stop drawing
      setCursor(px, py, "");
      setStatus("idle", "Open hand — not drawing");
      finishStroke();
    } else if (twoFingers) {
      // Two fingers → pause (can be used for select later)
      setCursor(px, py, "");
      setStatus("idle", "Two fingers — paused");
      finishStroke();
    } else {
      setCursor(px, py, "");
      setStatus("idle", "Show index finger to draw");
      finishStroke();
    }
  }

  function finishStroke() {
    if (isDrawing) {
      isDrawing = false;
      currentStroke = null;
      prevPoint = null;
      redrawAllStrokes(); // clean re-render
    }
  }

  // ─── Camera start ───
  const camera = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
    width: 1280,
    height: 720,
  });

  camera
    .start()
    .then(() => {
      setTimeout(() => loadingOverlay.classList.add("hidden"), 1200);
    })
    .catch((err) => {
      console.error("Camera error:", err);
      loadingOverlay.querySelector(".loading-text").textContent =
        "Camera access denied. Please allow camera and refresh.";
    });
})();
