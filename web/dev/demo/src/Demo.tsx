import { Audio, Video } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import take from "../public/take/take.json";

/** the take (scripts/record.mjs): its size, length and the shots the camera follows */
type Shot = {
  t: number;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  zoom: number;
};
const SHOTS = take.shots as Shot[];
const SRC_W = take.width;
const SRC_H = take.height;
export const TAKE_SECONDS = take.end / 1000;

/** how long the camera takes to move to a shot, and how early it starts (it arrives as the action starts) */
const MOVE = 1.1;
const LEAD = 0.45;
const BG = "#171f21";

/** where the camera looks for one shot: the take's scale and the source point at the frame's centre */
function view(s: Shot) {
  const fit = 1920 / SRC_W;
  const scale = fit * s.zoom;
  const vw = SRC_W / s.zoom;
  const vh = SRC_H / s.zoom;
  const clamp = (v: number, size: number, src: number) =>
    Math.min(src - size / 2, Math.max(size / 2, v));
  return {
    scale,
    cx: clamp(s.rect.x + s.rect.width / 2, vw, SRC_W),
    cy: clamp(s.rect.y + s.rect.height / 2, vh, SRC_H),
  };
}

/** the camera at time t: each shot's view, eased in from the one before */
function camera(t: number) {
  let cur = view(SHOTS[0]);
  for (let i = 1; i < SHOTS.length; i++) {
    const start = SHOTS[i].t / 1000 - LEAD;
    if (t < start) break;
    const k = interpolate(t, [start, start + MOVE], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.45, 0, 0.2, 1),
    });
    const next = view(SHOTS[i]);
    cur = {
      scale: cur.scale + (next.scale - cur.scale) * k,
      cx: cur.cx + (next.cx - cur.cx) * k,
      cy: cur.cy + (next.cy - cur.cy) * k,
    };
  }
  return cur;
}

/** the brand: the doll and the wordmark on the app's night colour */
const Brand: React.FC<{ opacity: number; scale: number }> = ({
  opacity,
  scale,
}) => (
  <AbsoluteFill
    style={{
      backgroundColor: BG,
      opacity,
      alignItems: "center",
      justifyContent: "center",
      gap: 36,
      flexDirection: "column",
    }}
  >
    <Img
      src={staticFile("brand/matryoshka.png")}
      style={{ width: 300, height: 300, scale: String(scale) }}
    />
    <Img
      src={staticFile("brand/wordmark-dark.svg")}
      style={{ width: 760, scale: String(scale) }}
    />
  </AbsoluteFill>
);

export const Demo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  const cam = camera(t);
  const end = durationInFrames / fps;

  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <div
          style={{
            position: "absolute",
            width: SRC_W,
            height: SRC_H,
            left: 0,
            top: 0,
            transformOrigin: "0 0",
            transform: `translate(${960 - cam.cx * cam.scale}px, ${540 - cam.cy * cam.scale}px) scale(${cam.scale})`,
          }}
        >
          <Video
            name="Take"
            src={staticFile("take/take.mp4")}
            muted
            style={{ width: SRC_W, height: SRC_H }}
          />
        </div>
      </AbsoluteFill>
      <Audio
        name="Take sound"
        src={staticFile("take/take.wav")}
        volume={(f) =>
          interpolate(
            f / fps,
            [0, 1.4, end - 2.2, end],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )
        }
      />
      <Brand
        opacity={interpolate(t, [0.5, 1.5], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.4, 0, 0.6, 1),
        })}
        scale={interpolate(t, [0, 1.5], [1, 1.06], {
          extrapolateRight: "clamp",
        })}
      />
      <Brand
        opacity={interpolate(t, [end - 3.2, end - 2], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.4, 0, 0.6, 1),
        })}
        scale={interpolate(t, [end - 3.2, end], [0.96, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })}
      />
    </AbsoluteFill>
  );
};
