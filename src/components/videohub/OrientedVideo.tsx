import { useRef, type VideoHTMLAttributes } from "react";
import { resolveMediaUrl } from "@/lib/media-url";
import { useVideoOrientation } from "@/lib/video-orientation";

interface OrientedVideoProps extends VideoHTMLAttributes<HTMLVideoElement> {
  src?: string | undefined;
  containerClassName?: string | undefined;
  fit?: "contain" | "cover" | undefined;
}

export function OrientedVideo({
  src,
  containerClassName = "relative w-full h-full overflow-hidden",
  fit = "contain",
  className = "h-full w-full object-contain",
  onLoadedMetadata,
  style,
  ...rest
}: OrientedVideoProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cleanSrc = resolveMediaUrl(src) || undefined;
  const { videoStyle, handleLoadedMetadata } = useVideoOrientation(cleanSrc, containerRef, fit);

  return (
    <div ref={containerRef} className={containerClassName}>
      <video
        {...rest}
        src={cleanSrc}
        className={className}
        style={videoStyle ? { ...style, ...videoStyle } : style}
        onLoadedMetadata={(e) => {
          handleLoadedMetadata(e.currentTarget);
          onLoadedMetadata?.(e);
        }}
      />
    </div>
  );
}
