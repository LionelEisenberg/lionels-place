import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { type CookLogResponse, getFeed, getCurrentUsername, getCurrentUserRole } from '../api'
import CookLogCard from '../components/CookLogCard'

export default function Activity() {
  const navigate = useNavigate()
  const [items, setItems] = useState<CookLogResponse[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)

  const username = getCurrentUsername()
  const isAdmin = getCurrentUserRole() === 'admin'

  useEffect(() => {
    loadFeed(1)
  }, [])

  const loadFeed = async (p: number) => {
    setLoading(true)
    try {
      const res = await getFeed(p)
      if (p === 1) {
        setItems(res.items)
      } else {
        setItems(prev => [...prev, ...res.items])
      }
      setHasMore(res.has_more)
      setPage(p)
    } catch { /* ignore */ }
    setLoading(false)
  }

  const handleUpdate = (updated: CookLogResponse) => {
    setItems(prev => prev.map(item =>
      item.id === updated.id ? updated : item
    ))
  }

  const handleNavigateToRecipe = (recipeId: number) => {
    navigate(`/recipes?open=${recipeId}`, { replace: false })
  }

  return (
    <div className="activity-feed">
      <h1>Feed</h1>
      {items.length === 0 && !loading && (
        <div className="activity-empty">No cooking activity yet. Go cook something!</div>
      )}
      {items.map(item => (
        <CookLogCard
          key={item.id}
          log={item}
          showRecipeName
          currentUsername={username}
          isAdmin={isAdmin}
          onUpdate={handleUpdate}
          onNavigateToRecipe={handleNavigateToRecipe}
        />
      ))}
      {hasMore && (
        <button
          className="btn btn-ghost activity-load-more"
          onClick={() => loadFeed(page + 1)}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  )
}
