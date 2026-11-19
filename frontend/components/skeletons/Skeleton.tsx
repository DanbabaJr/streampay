import type { CSSProperties, ReactNode } from "react";

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * Base skeleton primitive with shimmer animation and reduced-motion support.
 * Mirrors dimensions via width/height props or CSS flex layout.
 */
export function Skeleton({
  width,
  height,
  borderRadius,
  className = "",
  style,
  children,
}: SkeletonProps) {
  const combinedStyle: CSSProperties = {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(borderRadius !== undefined ? { borderRadius } : {}),
    ...style,
  };

  return (
    <span
      className={`skeleton-shimmer ${className}`.trim()}
      style={combinedStyle}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

export default Skeleton;
