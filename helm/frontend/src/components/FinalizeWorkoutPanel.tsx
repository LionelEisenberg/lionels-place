import { useState } from 'react';
import { parseInputAsync, pollJobStatus, ackLlmJob, finalizeActivity,
         type PendingGoogleSession, type ParsedIntent } from '../api';
import { WorkoutIntentCard } from './WorkoutIntentCard';

const MAX_POLLS = 90;   // ~90s ceiling before we stop waiting on the parse job

export function FinalizeWorkoutPanel(
  { target, onDone, onCancel }: { target: PendingGoogleSession; onDone: () => void; onCancel: () => void }
) {
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [intent, setIntent] = useState<ParsedIntent | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parse = async () => {
    if (!text.trim()) return;
    setParsing(true);
    setError(null);
    try {
      const { job_id } = await parseInputAsync(text, target.date);
      try {
        let status = await pollJobStatus(job_id);
        for (let i = 0; i < MAX_POLLS && (status.status === 'pending' || status.status === 'processing'); i++) {
          await new Promise(r => setTimeout(r, 1000));
          status = await pollJobStatus(job_id);
        }
        if (status.status !== 'completed') {
          setError(status.status === 'failed' ? 'Parsing failed — try again.' : 'Parsing timed out — try again.');
          return;
        }
        const intents: ParsedIntent[] = (status.result?.intents as ParsedIntent[]) ?? [];
        const workout = intents.find(i => i.type === 'workout' && i.workout_data) ?? null;
        setIntent(workout);
        if (!workout) setError('No workout found in that text — rephrase, or lock it in as-is.');
      } finally {
        // This parse rides the shared "dashboard_parse" job context. Ack it so it
        // can't resurface as a phantom staged card the next time the Dashboard mounts.
        ackLlmJob(job_id).catch(() => {});
      }
    } catch {
      setError('Couldn’t reach the parser — check your connection and try again.');
    } finally {
      setParsing(false);
    }
  };

  const confirm = async () => {
    setSaving(true);
    setError(null);
    try {
      await finalizeActivity(target.activity_id, intent?.workout_data?.exercises ?? []);
      onDone();
    } catch {
      setError('Couldn’t lock it in — try again.');
      setSaving(false);
    }
  };

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-medium)',
                  borderRadius: 'var(--radius-md)', padding: 14, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Add detail — {target.label}</div>
      <textarea value={text} onChange={e => setText(e.target.value)}
                placeholder="e.g. bench 135x8x8x7, incline db 50x10; or 30 laps"
                style={{ width: '100%', minHeight: 60, background: 'var(--bg-input)',
                         border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-sm)',
                         color: 'var(--text-primary)', padding: 8 }} />
      {intent?.workout_data && (
        <div style={{ marginTop: 10 }}><WorkoutIntentCard data={intent.workout_data} /></div>
      )}
      {error && (
        <div style={{ marginTop: 8, fontSize: '0.82rem', color: 'var(--accent-red, #e5484d)' }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        {!intent
          ? <button className="btn btn-primary" disabled={parsing || !text.trim()} onClick={parse}>{parsing ? 'Parsing…' : 'Parse'}</button>
          : <button className="btn btn-primary" disabled={saving} onClick={confirm}>{saving ? 'Saving…' : 'Lock it in'}</button>}
      </div>
    </div>
  );
}
