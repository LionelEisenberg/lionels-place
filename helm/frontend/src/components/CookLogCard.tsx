import { useState } from 'react'
import {
  type CookLogResponse,
  getCookLogPhotoUrl,
  toggleReaction,
  addComment,
  deleteComment,
} from '../api'
import { ratingToDots, relativeDate } from '../utils/recipe-helpers'

const PRESET_EMOJIS = ['🔥', '😋', '👨‍🍳', '💯', '🤤', '👎']

interface CookLogCardProps {
  log: CookLogResponse
  showRecipeName?: boolean
  currentUsername?: string | null
  isAdmin?: boolean
  onUpdate?: (updated: CookLogResponse) => void
  onNavigateToRecipe?: (recipeId: number) => void
}

export default function CookLogCard({
  log,
  showRecipeName = false,
  currentUsername,
  isAdmin = false,
  onUpdate,
  onNavigateToRecipe,
}: CookLogCardProps) {
  const [showComments, setShowComments] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [photoIndex, setPhotoIndex] = useState(0)

  const handleReaction = async (emoji: string) => {
    try {
      const updated = await toggleReaction(log.recipe_id, log.id, emoji)
      onUpdate?.(updated)
    } catch { /* ignore */ }
  }

  const handleAddComment = async () => {
    const text = commentText.trim()
    if (!text || submitting) return
    setSubmitting(true)
    try {
      const updated = await addComment(log.recipe_id, log.id, text)
      setCommentText('')
      onUpdate?.(updated)
    } catch { /* ignore */ }
    setSubmitting(false)
  }

  const handleDeleteComment = async (commentId: number) => {
    try {
      await deleteComment(log.recipe_id, log.id, commentId)
      const updated = {
        ...log,
        comments: log.comments.filter(c => c.id !== commentId),
      }
      onUpdate?.(updated)
    } catch { /* ignore */ }
  }

  const photos = log.photo_filenames || []
  const commentCount = log.comments?.length || 0

  return (
    <div className="clc-card">
      {/* Header */}
      <div className="clc-header">
        <div className="clc-user-info">
          {log.cooked_by && (
            <span className="clc-avatar">{log.cooked_by[0].toUpperCase()}</span>
          )}
          <span className="clc-username">{log.cooked_by || 'Unknown'}</span>
          <span className="clc-time">{relativeDate(log.created_at) || ''}</span>
        </div>
        {showRecipeName && log.recipe_name && (
          <button
            className="clc-recipe-link"
            onClick={() => onNavigateToRecipe?.(log.recipe_id)}
          >
            {log.recipe_name}
          </button>
        )}
      </div>

      {/* Photos carousel */}
      {photos.length > 0 && (
        <div className="clc-photos">
          <img
            src={getCookLogPhotoUrl(photos[photoIndex])}
            alt="Cook"
            className="clc-photo img-fade"
            loading="lazy"
            onLoad={e => (e.target as HTMLImageElement).classList.add('loaded')}
          />
          {photos.length > 1 && (
            <div className="clc-photo-nav">
              <button
                className="clc-photo-btn"
                disabled={photoIndex === 0}
                onClick={() => setPhotoIndex(i => i - 1)}
              >&#8249;</button>
              <span className="clc-photo-count">{photoIndex + 1}/{photos.length}</span>
              <button
                className="clc-photo-btn"
                disabled={photoIndex === photos.length - 1}
                onClick={() => setPhotoIndex(i => i + 1)}
              >&#8250;</button>
            </div>
          )}
        </div>
      )}

      {/* Body: notes + rating */}
      <div className="clc-body">
        {log.notes && <div className="clc-notes">{log.notes}</div>}
        {log.rating_comment && <div className="clc-rating-comment">"{log.rating_comment}"</div>}
        <div className="clc-meta">
          {log.rating != null && (
            <span className="clc-rating">
              <span className="rb-rating-dot-row">
                {ratingToDots(log.rating).map((dot, i) => (
                  <span key={i} className={`rb-rating-dot ${dot}`} style={{ width: 6, height: 6 }} />
                ))}
              </span>
              <span className="rb-rating-number">{log.rating}/10</span>
            </span>
          )}
          {log.guests != null && log.guests > 0 && (
            <span className="clc-guests">{log.guests} guests</span>
          )}
        </div>
      </div>

      {/* Reaction bar */}
      <div className="clc-reactions">
        <div className="clc-emoji-group">
          {PRESET_EMOJIS.map(emoji => {
            const reaction = log.reactions?.find(r => r.emoji === emoji)
            const count = reaction?.count || 0
            const active = reaction?.users?.includes(currentUsername || '') || false
            return (
              <button
                key={emoji}
                className={`clc-reaction-btn${active ? ' active' : ''}`}
                onClick={() => handleReaction(emoji)}
              >
                {emoji}{count > 0 && <span className="clc-reaction-count">{count}</span>}
              </button>
            )
          })}
        </div>

        <button
          className="clc-comment-toggle"
          onClick={() => setShowComments(!showComments)}
        >
          💬{commentCount > 0 && <span className="clc-reaction-count">{commentCount}</span>}
        </button>
      </div>

      {/* Comment thread */}
      {showComments && (
        <div className="clc-comments">
          {log.comments?.map(c => (
            <div key={c.id} className="clc-comment">
              <span className="clc-comment-avatar">
                {c.username ? c.username[0].toUpperCase() : '?'}
              </span>
              <div className="clc-comment-body">
                <span className="clc-comment-user">{c.username || 'Unknown'}</span>
                <span className="clc-comment-text">{c.text}</span>
                <span className="clc-comment-time">{relativeDate(c.created_at) || ''}</span>
              </div>
              {(isAdmin || c.username === currentUsername) && (
                <button
                  className="clc-comment-del"
                  onClick={() => handleDeleteComment(c.id)}
                >&times;</button>
              )}
            </div>
          ))}
          <div className="clc-comment-input">
            <input
              type="text"
              placeholder="Add a comment..."
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddComment()}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={handleAddComment}
              disabled={!commentText.trim() || submitting}
            >Post</button>
          </div>
        </div>
      )}
    </div>
  )
}
