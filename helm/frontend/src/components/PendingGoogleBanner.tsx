import { useEffect, useState, type CSSProperties } from 'react';
import { getPendingGoogle, finalizeActivity, type PendingGoogleSession } from '../api';
import { friendlyDate, weekdayName } from '../dates';
import { activityEmoji, activityColor, formatRange } from '../utils/session-helpers';
import { statTiles } from '../utils/activity-stats';

const CSS = `
.pw-wrap { margin-bottom: 20px; }
.pw-head { display:flex; align-items:center; gap:11px; margin:2px 2px 13px; }
.pw-pulse { width:8px; height:8px; border-radius:50%; background:var(--accent-emerald); flex:none; animation:pw-pulse 2.6s ease-out infinite; }
@keyframes pw-pulse { 0%{box-shadow:0 0 0 0 rgba(16,185,129,.55)} 70%{box-shadow:0 0 0 9px rgba(16,185,129,0)} 100%{box-shadow:0 0 0 0 rgba(16,185,129,0)} }
.pw-head-k { font-size:.62rem; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:var(--text-muted); }
.pw-head-t { font-size:.92rem; font-weight:700; color:var(--text-primary); letter-spacing:-.01em; }
.pw-head-t b { color:var(--accent-emerald); }
.pw-head-s { font-size:.74rem; color:var(--text-muted); }
.pw-grid { display:flex; flex-direction:column; gap:10px; }

.pw-card {
  position:relative; overflow:hidden;
  display:flex; align-items:center; gap:15px; flex-wrap:wrap;
  padding:13px 15px 13px 17px;
  background: linear-gradient(115deg, color-mix(in srgb, var(--acc) 10%, transparent), transparent 46%), var(--bg-card);
  border:1px solid var(--border-subtle); border-radius:var(--radius-lg);
  opacity:0; transform:translateY(9px); animation:pw-in .5s cubic-bezier(.2,.75,.3,1) forwards;
  transition:transform .18s ease, border-color .2s ease, box-shadow .2s ease;
}
.pw-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--acc); box-shadow:0 0 13px color-mix(in srgb, var(--acc) 70%, transparent); }
.pw-card:hover { transform:translateY(-2px); border-color:color-mix(in srgb, var(--acc) 42%, var(--border-medium)); box-shadow:0 12px 34px -14px color-mix(in srgb, var(--acc) 45%, transparent); }
@keyframes pw-in { to { opacity:1; transform:none; } }

.pw-badge { flex:none; width:46px; height:46px; border-radius:14px; display:grid; place-items:center; font-size:23px;
  background:color-mix(in srgb, var(--acc) 15%, var(--bg-glass)); border:1px solid color-mix(in srgb, var(--acc) 34%, transparent);
  box-shadow:inset 0 0 14px color-mix(in srgb, var(--acc) 20%, transparent), 0 0 18px -7px color-mix(in srgb, var(--acc) 55%, transparent); }

.pw-id { flex:1 1 138px; min-width:120px; }
.pw-name { font-weight:750; font-size:1rem; letter-spacing:.01em; color:var(--text-primary); line-height:1.05; text-transform:capitalize; }
.pw-meta { margin-top:4px; font-family:var(--font-mono); font-size:.71rem; color:var(--text-muted); display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.pw-meta .s { opacity:.4; }

.pw-stats { display:flex; flex-wrap:wrap; gap:6px; align-items:center; flex:3 1 240px; }
.pw-stat { padding:6px 11px; border-radius:10px; background:var(--bg-glass); border:1px solid var(--border-subtle); display:flex; flex-direction:column; gap:3px; }
.pw-stat.hero { background:color-mix(in srgb, var(--acc) 13%, transparent); border-color:color-mix(in srgb, var(--acc) 30%, transparent); }
.pw-v { font-family:var(--font-mono); font-weight:700; font-size:.94rem; line-height:1; letter-spacing:-.02em; color:var(--text-primary); }
.pw-stat.hero .pw-v { color:var(--acc); font-size:1.06rem; }
.pw-u { font-size:.55rem; text-transform:uppercase; letter-spacing:.11em; color:var(--text-muted); white-space:nowrap; }

.pw-actions { display:flex; gap:8px; flex:none; margin-left:auto; }
.pw-btn { padding:8px 14px; border-radius:var(--radius-sm); font-size:.79rem; font-weight:650; cursor:pointer; white-space:nowrap; font-family:var(--font-sans); transition:all .15s ease; }
.pw-btn:disabled { opacity:.55; cursor:default; }
.pw-ghost { background:transparent; border:1px solid var(--border-medium); color:var(--text-secondary); }
.pw-ghost:hover:not(:disabled) { border-color:var(--acc); color:var(--text-primary); background:color-mix(in srgb, var(--acc) 9%, transparent); }
.pw-lock { border:1px solid color-mix(in srgb, var(--acc) 58%, transparent); background:color-mix(in srgb, var(--acc) 18%, transparent); color:var(--text-primary); }
.pw-lock:hover:not(:disabled) { background:color-mix(in srgb, var(--acc) 30%, transparent); box-shadow:0 0 18px -5px color-mix(in srgb, var(--acc) 60%, transparent); }

/* Desktop: size each card to its content (a tidy left-aligned block) instead of
   stretching full-width and letting the stats float in a sea of empty space.
   Mobile keeps the full-width wrapping layout below this breakpoint. */
@media (min-width: 720px) {
  .pw-grid { align-items: flex-start; }
  .pw-card { width: fit-content; max-width: 100%; }
  .pw-actions { margin-left: 18px; }
}
`;

export function PendingGoogleBanner(
  { reloadKey, onChanged, onAddDetail }:
  { reloadKey: number; onChanged: () => void; onAddDetail: (s: PendingGoogleSession) => void }
) {
  const [pending, setPending] = useState<PendingGoogleSession[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = () => getPendingGoogle().then(setPending).catch(() => setPending([]));
  useEffect(() => { load(); }, [reloadKey]);

  if (pending.length === 0) return null;

  const finalizeAsIs = async (s: PendingGoogleSession) => {
    setBusy(s.activity_id);
    try { await finalizeActivity(s.activity_id, []); await load(); onChanged(); }
    finally { setBusy(null); }
  };

  return (
    <div className="pw-wrap">
      <style>{CSS}</style>
      <div className="pw-head">
        <span className="pw-pulse" />
        <div>
          <div className="pw-head-k">⌚ from your watch</div>
          <div className="pw-head-t"><b>{pending.length}</b> workout{pending.length !== 1 ? 's' : ''} not in your log yet
            <span className="pw-head-s"> · lock in the ones you did</span>
          </div>
        </div>
      </div>

      <div className="pw-grid">
        {pending.map((s, i) => {
          const acc = activityColor(s.activity);
          const isBusy = busy === s.activity_id;
          const range = formatRange(s.start, s.end);
          return (
            <div key={s.activity_id} className="pw-card"
                 style={{ ['--acc']: acc, animationDelay: `${i * 55}ms`, opacity: isBusy ? 0.6 : undefined } as CSSProperties}>
              <div className="pw-badge">{activityEmoji(s.activity)}</div>

              <div className="pw-id">
                <div className="pw-name">{s.label}</div>
                <div className="pw-meta">
                  <span>{weekdayName(s.date)}</span><span className="s">·</span>
                  <span>{friendlyDate(s.date)}</span>
                  {range && <><span className="s">·</span><span>{range}</span></>}
                </div>
              </div>

              <div className="pw-stats">
                {statTiles(s).map((st, k) => (
                  <div key={k} className={`pw-stat${st.hero ? ' hero' : ''}`}>
                    <span className="pw-v">{st.v}</span>
                    <span className="pw-u">{st.u}</span>
                  </div>
                ))}
              </div>

              <div className="pw-actions">
                <button className="pw-btn pw-ghost" disabled={isBusy} onClick={() => onAddDetail(s)}>Add detail</button>
                <button className="pw-btn pw-lock" disabled={isBusy} onClick={() => finalizeAsIs(s)}>{isBusy ? 'Locking…' : 'Lock in'}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
