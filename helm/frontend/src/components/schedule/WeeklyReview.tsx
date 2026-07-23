import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { getWeeklyReview, type WeeklyReviewResponse } from '../../api'

interface WeeklyReviewProps {
  weekStart: string
  onClose: () => void
}

const CAT_COLORS: Record<string, string> = {
  workout: '#34d399',
  meals: '#f59e0b',
  leetcode: '#818cf8',
  job_search: '#f97316',
  productivity: '#8b5cf6',
  personal: '#38bdf8',
}

export default function WeeklyReview({ weekStart, onClose }: WeeklyReviewProps) {
  const [review, setReview] = useState<WeeklyReviewResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getWeeklyReview(weekStart)
      .then(setReview)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [weekStart])

  if (loading || !review) {
    return (
      <div className="weekly-review-overlay" onClick={onClose}>
        <div className="weekly-review" onClick={e => e.stopPropagation()}>
          <div className="loading-overlay"><span className="loading-spinner" /></div>
        </div>
      </div>
    )
  }

  const trendData = review.trend.map(t => ({
    ...t,
    fill: t.week_start === weekStart ? '#34d399' : 'rgba(129, 140, 248, 0.4)',
  }))

  return (
    <div className="weekly-review-overlay" onClick={onClose}>
      <div className="weekly-review" onClick={e => e.stopPropagation()}>
        <div className="weekly-review-header">
          <span>Weekly Review</span>
          <button className="block-popover-close" onClick={onClose}>×</button>
        </div>

        <div className="weekly-review-body">
          <div className="weekly-review-adherence">
            <div className="weekly-review-pct">{Math.round(review.adherence_pct)}%</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Overall Adherence</div>
          </div>

          <div className="weekly-review-section">
            <div className="weekly-review-section-label">BY CATEGORY</div>
            {Object.entries(review.by_category).map(([cat, data]) => (
              <div key={cat} className="weekly-review-cat-row">
                <div className="weekly-review-cat-name" style={{ color: CAT_COLORS[cat] || 'var(--text-primary)' }}>
                  {cat.replace('_', ' ')}
                </div>
                <div className="weekly-review-cat-bar-bg">
                  <div
                    className="weekly-review-cat-bar-fill"
                    style={{
                      width: `${data.total > 0 ? (data.done / data.total) * 100 : 0}%`,
                      background: CAT_COLORS[cat] || 'var(--accent-indigo)',
                    }}
                  />
                </div>
                <div className="weekly-review-cat-count">{data.done}/{data.total}</div>
              </div>
            ))}
          </div>

          <div className="weekly-review-hours">
            <div className="weekly-review-hour-card">
              <div className="weekly-review-hour-val">{review.planned_hours}h</div>
              <div className="weekly-review-hour-label">Planned</div>
            </div>
            <div className="weekly-review-hour-card">
              <div className="weekly-review-hour-val" style={{ color: 'var(--accent-emerald)' }}>{review.completed_hours}h</div>
              <div className="weekly-review-hour-label">Completed</div>
            </div>
          </div>

          {review.skipped_list.length > 0 && (
            <div className="weekly-review-section">
              <div className="weekly-review-section-label">SKIPPED</div>
              {review.skipped_list.map((s, i) => (
                <div key={i} className="weekly-review-skipped-row">
                  <span style={{ color: 'var(--accent-rose)' }}>✗</span>
                  <span>{s.name}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>{s.duration_hrs}h</span>
                </div>
              ))}
            </div>
          )}

          <div className="weekly-review-section">
            <div className="weekly-review-section-label">ADHERENCE TREND</div>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={trendData}>
                <XAxis dataKey="week" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis hide domain={[0, 100]} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-medium)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                  formatter={(v) => [`${v ?? 0}%`, 'Adherence'] as [string, string]}
                />
                <Bar dataKey="adherence_pct" radius={[4, 4, 0, 0]}>
                  {trendData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  )
}
