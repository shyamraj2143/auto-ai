import { createElement, Fragment, type ElementType, type ReactNode } from "react";

export function AnimatePresence({ children }: { children?: ReactNode; initial?: boolean; mode?: string }) {
  return <Fragment>{children}</Fragment>;
}

function staticElement(Tag: ElementType) {
  return function StaticElement({
    children,
    initial: _initial,
    animate: _animate,
    exit: _exit,
    transition: _transition,
    variants: _variants,
    layout: _layout,
    layoutId: _layoutId,
    whileHover: _whileHover,
    whileTap: _whileTap,
    ...props
  }: Record<string, unknown> & { children?: ReactNode }) {
    return createElement(Tag, props, children);
  };
}

export const motion = {
  article: staticElement("article"),
  div: staticElement("div"),
  p: staticElement("p"),
  span: staticElement("span")
};
