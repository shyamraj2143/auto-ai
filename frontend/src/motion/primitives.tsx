import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type StaticProps = { children: ReactNode; className?: string };

export function AnimatedPage({ children, className }: StaticProps) {
  return <div className={className}>{children}</div>;
}

export function Reveal({ children, className }: StaticProps) {
  return <div className={className}>{children}</div>;
}

export function StaggerGroup({ children, className }: StaticProps) {
  return <div className={className}>{children}</div>;
}

export function StaggerItem({ children, className }: StaticProps) {
  return <div className={className}>{children}</div>;
}

export function FlyText({ text, className }: { text: string; className?: string }) {
  return <span className={className}>{text}</span>;
}

export function PressableButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} />;
}

export function TiltCard({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return <div {...props}>{children}</div>;
}

export function StreamingPulse({ active }: { active: boolean }) {
  return <span className={active ? "streaming-pulse active" : "streaming-pulse"} aria-hidden="true" />;
}
