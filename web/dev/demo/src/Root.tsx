import { Composition } from "remotion";
import { Demo, TAKE_SECONDS } from "./Demo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Demo"
      component={Demo}
      durationInFrames={Math.floor(TAKE_SECONDS * 30)}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
