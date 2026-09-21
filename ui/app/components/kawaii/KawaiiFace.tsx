import type { CSSProperties } from "react";
import "./kawaii.css";
import { KAWAII_FACES } from "./kawaii-faces";
import { loopForFace } from "./KawaiiMascot";

// One kawaii face on its own — the same artwork and idle loop the mascot
// uses, so the face strip previews exactly what each body will show.
export default function KawaiiFace({
  id,
  ink = "#24211f",
  size = 120,
  label,
  className,
}: {
  id: string;
  ink?: string;
  size?: number;
  label?: string;
  className?: string;
}) {
  const face = KAWAII_FACES.find((f) => f.id === id) ?? KAWAII_FACES[0];
  const [w, h] = face.viewBox.split(" ").slice(2).map(Number);
  const style = { "--k-ink": ink } as CSSProperties;

  return (
    <svg
      className={className ? `kface-alone ${className}` : "kface-alone"}
      role="img"
      aria-label={label ?? `${face.label} face`}
      width={size}
      height={Math.round((size * h) / w)}
      viewBox={face.viewBox}
      fill="none"
      style={style}
    >
      <g className={loopForFace(face.id)} dangerouslySetInnerHTML={{ __html: face.art }} />
    </svg>
  );
}
