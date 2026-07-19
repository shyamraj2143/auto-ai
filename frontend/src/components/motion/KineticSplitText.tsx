import { Fragment, type CSSProperties } from "react";
import { splitKineticWords } from "../../motion/kineticRevealConfig";

export function KineticSplitText({ text, disabled = false }: { text: string; disabled?: boolean }) {
  const words = disabled ? null : splitKineticWords(text);
  if (!words) return text;
  return (
    <span aria-hidden="true">
      {words.map((word, index) => (
        <Fragment key={`${word}-${index}`}>
          <span
            className="kinetic-split-word"
            style={{ "--kinetic-word-index": index } as CSSProperties}
          >
            {word}
          </span>
          {index < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}
