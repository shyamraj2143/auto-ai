export function LuxuryLoader() {
  return (
    <div className="luxury-loader" data-luxury-loader="cinematic-v12" aria-hidden="true">
      <div className="luxury-loader-grid" data-luxury-loader-grid />
      <div className="luxury-loader-panel luxury-loader-panel-top" data-luxury-loader-top>
        <span className="luxury-loader-ghost">AUTO—AI</span>
      </div>
      <div className="luxury-loader-panel luxury-loader-panel-bottom" data-luxury-loader-bottom>
        <span className="luxury-loader-ghost">PRISM</span>
      </div>
      <div className="luxury-loader-beam" data-luxury-loader-beam />
      <div className="luxury-loader-mark" data-luxury-loader-mark>
        <span className="luxury-loader-brand">
          {Array.from("AUTO–AI").map((character, index) => (
            <i data-luxury-loader-letter key={`${character}-${index}`}>{character}</i>
          ))}
        </span>
        <small>Prism Intelligence</small>
      </div>
      <span className="luxury-loader-progress" data-luxury-loader-progress>000</span>
      <span className="luxury-loader-coordinate is-top">35.6762° N</span>
      <span className="luxury-loader-coordinate is-bottom">139.6503° E</span>
    </div>
  );
}
