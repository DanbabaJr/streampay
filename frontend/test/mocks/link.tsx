import React from "react";

export default function Link({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: React.ReactNode }) {
  return React.createElement("a", { href, ...props }, children);
}
