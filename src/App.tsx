import { useEffect, useRef, useState } from "react";
import { FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type Action = "next" | "prev" | "hand" | "mic" | "cam" | "start";

const MAPPING: Record<string, Action> = {
  Victory: "next",
  Pointing_Up: "prev",
  Open_Palm: "hand",
  Closed_Fist: "mic",
  Thumb_Down: "cam",
  Thumb_Up: "start",
};

const ACTION_LABEL: Record<Action, string> = {
  next: "Next slide",
  prev: "Previous slide",
  hand: "Raise/lower hand",
  mic: "Mute/unmute mic",
  cam: "Meeting camera on/off",
  start: "Start meeting",
};

const SLIDES = [
  "Slide 1: Welcome to the Touchless Meeting Demo",
  "Slide 2: Problem - Controls need keyboards and mice",
  "Slide 3: Solution - Real-time hand gesture recognition",
  "Slide 4: Tech - React, MediaPipe, browser-only",
  "Slide 5: Thank you!",
];

const CONFIDENCE = 0.6;
const STABLE_FRAMES = 5;
const COOLDOWN_MS = 1000;

type LogItem = { time: string; gesture: string; action: string };

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const recognizerRef = useRef<GestureRecognizer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const runningRef = useRef(false);
  const lastVideoTime = useRef(-1);

  // gesture controller memory
  const candidateRef = useRef("");
  const countRef = useRef(0);
  const firedRef = useRef<string | null>(null);
  const lastActionTime = useRef(0);
  const meetingRef = useRef(false);

  const [status, setStatus] = useState("Camera is off");
  const [gesture, setGesture] = useState("None");
  const [score, setScore] = useState(0);
  const [running, setRunning] = useState(false);

  const [meetingActive, setMeetingActiveState] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [slide, setSlide] = useState(0);
  const [log, setLog] = useState<LogItem[]>([]);
  const pdfRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const totalRef = useRef(SLIDES.length);
  const [pdfLoaded, setPdfLoaded] = useState(false);
  const [total, setTotal] = useState(SLIDES.length);

  function setMeeting(v: boolean) {
    meetingRef.current = v;
    setMeetingActiveState(v);
  }

  function addLog(g: string, action: string) {
    const time = new Date().toLocaleTimeString();
    setLog((prev) => [{ time, gesture: g, action }, ...prev].slice(0, 8));
  }

  function doAction(a: Action, g: string) {
    if (a === "start") {
      if (meetingRef.current) return;
      setMeeting(true);
    } else if (!meetingRef.current) {
      return; // other actions only work during a meeting
    } else if (a === "next") {
      setSlide((s) => Math.min(s + 1, totalRef.current - 1));
    } else if (a === "prev") {
      setSlide((s) => Math.max(s - 1, 0));
    } else if (a === "hand") {
      setHandRaised((v) => !v);
    } else if (a === "mic") {
      setMicOn((v) => !v);
    } else if (a === "cam") {
      setCamOn((v) => !v);
    }
    addLog(g, ACTION_LABEL[a]);
  }

  const doActionRef = useRef(doAction);
  doActionRef.current = doAction;

  function processGesture(name: string, sc: number) {
    // no hand, "None", or low confidence = treat as released
    if (name === "No hand" || name === "None" || sc < CONFIDENCE) {
      candidateRef.current = "";
      countRef.current = 0;
      firedRef.current = null;
      return;
    }
    if (name !== candidateRef.current) {
      candidateRef.current = name;
      countRef.current = 1;
      if (name !== firedRef.current) firedRef.current = null;
      return;
    }
    countRef.current += 1;
    const now = performance.now();
    const action = MAPPING[name];
    if (
      action &&
      countRef.current >= STABLE_FRAMES &&
      firedRef.current === null &&
      now - lastActionTime.current > COOLDOWN_MS
    ) {
      firedRef.current = name; // fire once per hold
      lastActionTime.current = now;
      doActionRef.current(action, name);
    }
  }

  function loop() {
    if (!runningRef.current) return;
    const video = videoRef.current;
    const rec = recognizerRef.current;
    if (video && rec && video.readyState >= 2 && video.currentTime !== lastVideoTime.current) {
      lastVideoTime.current = video.currentTime;
      const result = rec.recognizeForVideo(video, performance.now());
      if (result.gestures.length > 0) {
        const top = result.gestures[0][0];
        setGesture(top.categoryName);
        setScore(top.score);
        processGesture(top.categoryName, top.score);
      } else {
        setGesture("No hand");
        setScore(0);
        processGesture("No hand", 0);
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }

  async function startCamera() {
    try {
      setStatus("Loading AI model...");
      if (!recognizerRef.current) {
        const vision = await FilesetResolver.forVisionTasks("/wasm");
        recognizerRef.current = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: { modelAssetPath: "/gesture_recognizer.task" },
          runningMode: "VIDEO",
          numHands: 1,
        });
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      runningRef.current = true;
      setRunning(true);
      setStatus("Camera on - show your hand");
      loop();
    } catch (e) {
      setStatus("Error: " + (e as Error).message);
    }
  }

  function stopCamera() {
    runningRef.current = false;
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setRunning(false);
    setGesture("None");
    setScore(0);
    setStatus("Camera is off");
  }

  function endMeeting() {
    if (window.confirm("End the simulated meeting?")) {
      setMeeting(false);
      setHandRaised(false);
      setMicOn(true);
      setCamOn(true);
      setSlide(0);
      addLog("Button", "End meeting");
    }
  }
    async function onPdfSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      pdfRef.current = pdf;
      totalRef.current = pdf.numPages;
      setTotal(pdf.numPages);
      setSlide(0);
      setPdfLoaded(true);
      addLog("Upload", "Loaded PDF: " + file.name);
    } catch (err) {
      alert("Could not open this PDF: " + (err as Error).message);
    }
  }

  useEffect(() => {
    if (!pdfLoaded || !pdfRef.current || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdfRef.current.getPage(slide + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1.2 });
        const canvas = canvasRef.current!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({
          canvasContext: canvas.getContext("2d")!,
          canvas,
          viewport,
        } as any).promise;
      } catch {
        /* ignore render interruptions */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slide, pdfLoaded, meetingActive]);

  const pill = (on: boolean, text: string, color: string) => (
    <span
      style={{
        display: "inline-block",
        padding: "6px 12px",
        borderRadius: 20,
        marginRight: 8,
        marginBottom: 8,
        background: on ? color : "#333",
        fontSize: 14,
      }}
    >
      {text}
    </span>
  );

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Touchless AI Meeting System</h1>
      <div style={{ background: "#3a2f00", padding: 8, borderRadius: 8, marginBottom: 16, fontSize: 14 }}>
        PROTOTYPE: the meeting below is SIMULATED. Gesture recognition is real (MediaPipe AI).
        Mic/camera indicators do not control your real devices.
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        {/* Left: camera + AI */}
        <div style={{ flex: "1 1 400px" }}>
          <h3>Camera and AI recognition</h3>
          <p style={{ color: "#aaa" }}>{status}</p>
          <video
            ref={videoRef}
            playsInline
            muted
            style={{ width: "100%", maxWidth: 480, borderRadius: 12, background: "#000", transform: "scaleX(-1)" }}
          />
          <div style={{ margin: "10px 0" }}>
            {!running ? (
              <button onClick={startCamera}>Start Camera</button>
            ) : (
              <button onClick={stopCamera}>Stop Camera</button>
            )}
          </div>
          <h3>Detected: {gesture} ({(score * 100).toFixed(0)}%)</h3>
          <div style={{ fontSize: 13, color: "#aaa", lineHeight: 1.7 }}>
            Gestures: Thumb Up = start meeting | Victory = next slide | Pointing Up = previous
            slide | Open Palm = raise hand | Fist = mute | Thumb Down = camera
          </div>
        </div>

        {/* Right: meeting */}
        <div style={{ flex: "1 1 400px" }}>
          <h3>Simulated meeting {meetingActive ? "(LIVE)" : "(not started)"}</h3>
          <div style={{ marginBottom: 8 }}>
            {pill(meetingActive, meetingActive ? "Meeting live" : "Meeting off", "#1a7f37")}
            {pill(handRaised, handRaised ? "Hand raised" : "Hand down", "#9a6700")}
            {pill(micOn, micOn ? "Mic on" : "Mic muted", "#0969da")}
            {pill(camOn, camOn ? "Camera on" : "Camera off", "#0969da")}
          </div>
          <div style={{ marginBottom: 12 }}>
            {!meetingActive ? (
              <button onClick={() => doAction("start", "Button")}>Start meeting</button>
            ) : (
              <button onClick={endMeeting}>End meeting</button>
            )}
            <button onClick={() => doAction("hand", "Button")}>Raise hand</button>
            <button onClick={() => doAction("mic", "Button")}>Mic</button>
            <button onClick={() => doAction("cam", "Button")}>Camera</button>
          </div>

          <div
            style={{
              background: "#1e232b",
              borderRadius: 12,
              padding: 24,
              minHeight: 140,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              fontSize: 20,
            }}
          >
            {!meetingActive ? (
              "Start the meeting to show slides"
            ) : pdfLoaded ? (
              <canvas ref={canvasRef} style={{ maxWidth: "100%", borderRadius: 8 }} />
            ) : (
              SLIDES[slide]
            )}
          </div>
                    <div
            style={{
              marginTop: 10,
              height: 70,
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 16px",
              background: camOn ? "#14532d" : "#111",
              border: "1px solid #444",
              fontSize: 15,
            }}
          >
            <span>
              {camOn ? "You (video on)" : "You (camera off)"}
            </span>
            <span>
              {handRaised ? "✋ " : ""}
              {micOn ? "🎤 Mic on" : "🔇 Muted"}
            </span>
          </div>
          <div style={{ margin: "10px 0" }}>
            <button onClick={() => doAction("prev", "Button")}>Previous</button>
            <button onClick={() => doAction("next", "Button")}>Next</button>
            <span style={{ color: "#aaa" }}>
              Slide {slide + 1} / {total}
            </span>
            <div style={{ marginTop: 10 }}>
              <input type="file" accept="application/pdf" onChange={onPdfSelected} />
            </div>
          </div>  
        </div>
      </div>

      <h3>Action log</h3>
      <div style={{ background: "#1e232b", borderRadius: 12, padding: 12, minHeight: 60, fontSize: 14 }}>
        {log.length === 0 && <span style={{ color: "#888" }}>No actions yet</span>}
        {log.map((l, i) => (
          <div key={i}>
            {l.time} - [{l.gesture}] {l.action}
          </div>
        ))}
      </div>
    </div>
  );
}