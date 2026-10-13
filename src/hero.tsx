import { useEffect, useState } from "react";
import { Cover, Icon, IconButton } from "./ui";

export interface Slide {
  key: string;
  title: string;
  summary: string;
  cover?: string;
  fallbackCover?: string;
  badge: string;
  primary: { label: string; onClick: () => void; play?: boolean };
  secondary: { label: string; onClick: () => void };
}

/** The Home highlight: one game at a time, with previous/next, dots and arrow-key support. */
export function HeroCarousel({ slides }: { slides: Slide[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (i >= slides.length) setI(0);
  }, [slides.length, i]);
  if (slides.length === 0) return null;
  const s = slides[Math.min(i, slides.length - 1)];
  const go = (d: number) => setI((n) => (n + d + slides.length) % slides.length);

  return (
    <section
      className="hero"
      aria-roledescription="carousel"
      aria-label="Highlighted games"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") go(-1);
        if (e.key === "ArrowRight") go(1);
      }}
    >
      <Cover src={s.cover} fallbackSrc={s.fallbackCover} title={s.title} className="hero-image" />
      <div className="hero-shade" />
      <div className="hero-content">
        <span className="hero-badge">{s.badge}</span>
        <h1 className="hero-title">{s.title}</h1>
        <p className="hero-summary">{s.summary}</p>
        <div className="row">
          <button className="btn primary" onClick={s.primary.onClick}>
            {s.primary.play && <Icon name="play" size={16} />} {s.primary.label}
          </button>
          <button className="btn" onClick={s.secondary.onClick}>{s.secondary.label}</button>
        </div>
      </div>
      {slides.length > 1 && (
        <>
          <div className="hero-arrows">
            <IconButton icon="left" label="Previous game" onClick={() => go(-1)} />
            <IconButton icon="right" label="Next game" onClick={() => go(1)} />
          </div>
          <div className="hero-dots" role="tablist" aria-label="Choose a highlighted game">
            {slides.map((d, n) => (
              <button
                key={d.key}
                role="tab"
                aria-selected={n === i}
                aria-label={d.title}
                className={`dot${n === i ? " on" : ""}`}
                onClick={() => setI(n)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
