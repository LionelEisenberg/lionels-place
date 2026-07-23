/**
 * API client for the fitness tracker backend.
 * Handles auth token injection and typed fetch wrappers.
 */

// Use Vite's BASE_URL (e.g., /helm/) to construct the API path.
// This ensures requests in production go to /helm/api, which Caddy routes to the backend.
const API_BASE = `${import.meta.env.BASE_URL}api`;

// Token is set once at app init from localStorage
let authToken: string = localStorage.getItem('helm_auth_token') || '';

export function setAuthToken(token: string): void {
  authToken = token;
  localStorage.setItem('helm_auth_token', token);
}

export function getAuthToken(): string {
  return authToken;
}

export function clearAuthToken(): void {
  authToken = '';
  localStorage.removeItem('helm_auth_token');
}

export function getCurrentUserRole(): string | null {
  if (!authToken) return null;
  try {
    const payload = JSON.parse(atob(authToken.split('.')[1]));
    return payload.role || null;
  } catch { return null; }
}

export function getCurrentUsername(): string | null {
  if (!authToken) return null;
  try {
    const payload = JSON.parse(atob(authToken.split('.')[1]));
    return payload.username || null;
  } catch { return null; }
}

export async function submitFeedback(title: string, description: string, type: 'feature' | 'bug'): Promise<{ ok: boolean; issue_url?: string }> {
  return apiFetch('/feedback', {
    method: 'POST',
    body: JSON.stringify({ title, description, type }),
  });
}

export interface UserInfo {
  username: string;
  role: string;
}

export interface LoginResponse {
  token: string;
  user: UserInfo;
}

export interface MeResponse {
  username: string;
  role: string;
  token?: string | null;
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Login failed' }));
    throw new Error(err.detail || 'Login failed');
  }
  return res.json();
}

export async function getMe(): Promise<MeResponse | null> {
  if (!authToken) return null;
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return null;
    const data: MeResponse = await res.json();
    // Silent token refresh
    if (data.token) {
      setAuthToken(data.token);
    }
    return data;
  } catch {
    return null;
  }
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`API error ${res.status}: ${errorBody}`);
  }

  return res.json() as Promise<T>;
}

// ==========================================
// Parse (Chat-First) Endpoints
// ==========================================

export interface MealItemData {
  name: string;
  quantity: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  confidence?: number;
  confidence_reason?: string;
}

export interface MealIntentData {
  meal: string;
  description: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  resolved_from?: string | null;
  items?: MealItemData[];
}

export interface ExerciseEntryData {
  exercise: string;
  category: 'Upper Body' | 'Lower Body' | 'Core' | 'Cardio';
  equipment_type: string;
  weight_lbs: string;
  reps_sets: string;
  notes: string;
  targeted_muscle_group: string;
}

export interface WorkoutIntentData {
  activity: string;
  label?: string | null;
  exercises: ExerciseEntryData[];
  session_notes?: string | null;
}

export interface WeightIntentData {
  weight_lbs: number;
}

export interface HabitIntentData {
  amount: number;
}

export interface CaffeineIntentData {
  amount_mg: number;
}

export interface MoodIntentData {
  mood: string;
}

export interface NoteIntentData {
  note: string;
}

export interface SleepIntentData {
  bedtime?: string | null;
  waketime?: string | null;
  hours: number;
}

export interface ParsedIntent {
  type: 'meal' | 'workout' | 'weight' | 'habit' | 'caffeine' | 'mood' | 'note' | 'sleep';
  confidence: number;
  source_text: string;
  date?: string | null;
  meal_data?: MealIntentData | null;
  workout_data?: WorkoutIntentData | null;
  weight_data?: WeightIntentData | null;
  habit_data?: HabitIntentData | null;
  caffeine_data?: CaffeineIntentData | null;
  mood_data?: MoodIntentData | null;
  note_data?: NoteIntentData | null;
  sleep_data?: SleepIntentData | null;
}

export interface ParseResponse {
  intents: ParsedIntent[];
  advice_response?: string | null;
  request_log_id?: string | null;
}

export interface CommitResponse {
  meals_created: number;
  workouts_created: number;
  weight_updated: boolean;
  habit_updated: boolean;
  caffeine_updated: boolean;
  mood_updated: boolean;
  notes_added: boolean;
  sleep_updated: boolean;
  daily_totals?: DailySummaryResponse | null;
}

export function commitIntents(date: string, intents: ParsedIntent[], requestLogId?: string | null): Promise<CommitResponse> {
  return apiFetch('/parse/commit', {
    method: 'POST',
    body: JSON.stringify({ date, intents, request_log_id: requestLogId }),
  });
}

// ==========================================
// Async Job Polling
// ==========================================

export interface AsyncJobSubmitResponse {
  job_id: string;
}

export interface AsyncJobStatusResponse {
  job_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
}

export function parseInputAsync(message: string, date?: string, imageBase64?: string): Promise<AsyncJobSubmitResponse> {
  const body: Record<string, string> = { message };
  if (date) body.date = date;
  if (imageBase64) body.image_base64 = imageBase64;
  return apiFetch('/parse/async', { method: 'POST', body: JSON.stringify(body) });
}

export function continueInputAsync(message: string, pendingIntents: ParsedIntent[]): Promise<AsyncJobSubmitResponse> {
  return apiFetch('/parse/continue/async', {
    method: 'POST',
    body: JSON.stringify({ message, pending_intents: pendingIntents }),
  });
}

export function advisorChatAsync(message: string): Promise<AsyncJobSubmitResponse> {
  return apiFetch('/advisor/chat/async', { method: 'POST', body: JSON.stringify({ message }) });
}

export function pollJobStatus(jobId: string): Promise<AsyncJobStatusResponse> {
  return apiFetch(`/jobs/${jobId}`);
}

export interface LLMJobResponse {
  job_id: string
  context: string
  task_type: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  response_text?: string | null
  response_payload?: Record<string, unknown> | null
  error?: string | null
}

export function listContextJobs(context: string): Promise<{ jobs: LLMJobResponse[] }> {
  return apiFetch(`/llm-jobs?context=${encodeURIComponent(context)}`)
}
export function ackLlmJob(jobId: string): Promise<LLMJobResponse> {
  return apiFetch(`/llm-jobs/${jobId}/ack`, { method: 'POST' })
}

// ==========================================
// Meals CRUD
// ==========================================

export interface MealResponse {
  id: number;
  date: string;
  meal: string;
  description: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  confidence?: number | null;
  items?: MealItemData[];
}

export function listMeals(startDate?: string, endDate?: string, limit = 100): Promise<MealResponse[]> {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate);
  if (endDate) params.set('end_date', endDate);
  params.set('limit', limit.toString());
  return apiFetch(`/meals?${params}`);
}

export function updateMeal(id: number, data: Partial<MealResponse>): Promise<MealResponse> {
  return apiFetch(`/meals/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function updateMealItems(id: number, items: MealItemData[]): Promise<MealResponse> {
  return apiFetch(`/meals/${id}/items`, { method: 'PUT', body: JSON.stringify(items) });
}

export function deleteMeal(id: number): Promise<void> {
  return apiFetch(`/meals/${id}`, { method: 'DELETE' });
}

export function duplicateMeal(id: number, date?: string): Promise<MealResponse> {
  const params = date ? `?date=${date}` : '';
  return apiFetch(`/meals/duplicate/${id}${params}`, { method: 'POST' });
}

export function mealSuggestions(q: string): Promise<string[]> {
  return apiFetch(`/meals/suggestions?q=${encodeURIComponent(q)}`);
}

export interface MealStats {
  avg_calories: number;
  avg_protein: number;
  avg_carbs: number;
  avg_fat: number;
  avg_fiber: number;
  meal_count: number;
  day_count: number;
  meals_per_day: number;
}

export function mealStats(startDate?: string, endDate?: string): Promise<MealStats> {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate);
  if (endDate) params.set('end_date', endDate);
  return apiFetch(`/meals/stats?${params}`);
}

// ==========================================
// Quick Add
// ==========================================

export interface QuickAddItem {
  name: string;
  quantity: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  frequency: number | null;
  is_pinned: boolean;
  pin_id: number | null;
}

export interface QuickAddData {
  pinned: QuickAddItem[];
  popular: QuickAddItem[];
  window_days: number;
}

export function getQuickAdd(): Promise<QuickAddData> {
  return apiFetch('/meals/quick-add');
}

export function pinQuickAddItem(name: string, quantity: string): Promise<QuickAddItem> {
  return apiFetch('/meals/quick-add/pins', {
    method: 'POST',
    body: JSON.stringify({ name, quantity }),
  });
}

export async function unpinQuickAddItem(pinId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/meals/quick-add/pins/${pinId}`, {
    method: 'DELETE',
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
}

export function logQuickAddMeal(
  mealType: 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack',
  items: MealItemData[],
  date?: string,
): Promise<MealResponse> {
  return apiFetch('/meals/quick-add/log', {
    method: 'POST',
    body: JSON.stringify({ meal_type: mealType, items, date: date ?? null }),
  });
}

// ==========================================
// Workouts CRUD
// ==========================================

export interface WorkoutResponse {
  id: number;
  date: string;
  category: 'Upper Body' | 'Lower Body' | 'Core' | 'Cardio';
  equipment_type: string;
  exercise: string;
  weight_lbs: string;
  reps_sets: string;
  notes: string;
  targeted_muscle_group: string;
}

export function listWorkouts(params?: { startDate?: string; endDate?: string; muscleGroup?: string; exercise?: string; limit?: number }): Promise<WorkoutResponse[]> {
  const p = new URLSearchParams();
  if (params?.startDate) p.set('start_date', params.startDate);
  if (params?.endDate) p.set('end_date', params.endDate);
  if (params?.muscleGroup) p.set('muscle_group', params.muscleGroup);
  if (params?.exercise) p.set('exercise', params.exercise);
  p.set('limit', (params?.limit || 100).toString());
  return apiFetch(`/workouts?${p}`);
}

export function updateWorkout(id: number, data: Partial<WorkoutResponse>): Promise<WorkoutResponse> {
  return apiFetch(`/workouts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

/** Row payload for creation; `activity_id` pins the row to an existing activity
 *  (per-activity edit flow) instead of the server's keyword heuristic. */
export type WorkoutCreatePayload = Partial<WorkoutResponse> & { activity_id?: number };

export function createWorkout(data: WorkoutCreatePayload[]): Promise<void> {
  return apiFetch(`/workouts/bulk`, { method: 'POST', body: JSON.stringify(data) });
}

export function deleteWorkout(id: number): Promise<void> {
  return apiFetch(`/workouts/${id}`, { method: 'DELETE' });
}

/** Structured cardio edit — the activity's own metadata columns. */
export interface ActivityUpdatePayload {
  label?: string;
  laps?: number | null;
  distance_m?: number | null;
  duration_min?: number | null;
  notes?: string | null;
}

export function updateActivity(id: number, data: ActivityUpdatePayload): Promise<DayLog> {
  return apiFetch(`/workouts/activities/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteActivity(id: number): Promise<void> {
  return apiFetch(`/workouts/activities/${id}`, { method: 'DELETE' });
}

export function exerciseHistory(exercise: string, limit = 20): Promise<WorkoutResponse[]> {
  return apiFetch(`/workouts/history/${encodeURIComponent(exercise)}?limit=${limit}`);
}

export interface ProgressionSession {
  date: string;
  weight_lbs: string;
  reps_sets: string;
  notes: string;
  max_weight: number;
  body_weight: number | null;
}

export interface ExerciseProgressionResponse {
  exercise: string;
  equipment_type: string;
  sessions: ProgressionSession[];
}

export function exerciseSearch(q: string, limit = 10): Promise<string[]> {
  return apiFetch(`/workouts/exercise-search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export function exerciseProgression(exerciseName: string): Promise<ExerciseProgressionResponse[]> {
  return apiFetch(`/workouts/progression/${encodeURIComponent(exerciseName)}`);
}

export interface PendingGoogleSession {
  activity_id: number;
  date: string;
  activity: string;
  label: string;
  start?: string | null;
  end?: string | null;
  duration_min?: number | null;
  distance_m?: number | null;
  calories_kcal?: number | null;
  credited_kcal?: number | null;
  avg_hr?: number | null;
  pace_s_per_km?: number | null;
  elevation_gain_m?: number | null;
  avg_cadence_spm?: number | null;
}

export function getPendingGoogle(): Promise<PendingGoogleSession[]> {
  return apiFetch(`/workouts/pending-google`);
}

export function finalizeActivity(activityId: number, exercises: ExerciseEntryData[]): Promise<void> {
  return apiFetch(`/workouts/activities/${activityId}/finalize`, {
    method: 'POST',
    body: JSON.stringify({ exercises }),
  });
}

// ==========================================
// Daily Summaries
// ==========================================

export interface DailySummaryResponse {
  id: number;
  date: string;
  day_of_week?: string;
  workout_type?: 'Push' | 'Pull' | 'Legs' | 'Cardio' | 'Mixed' | null;
  weight_lbs?: number;
  bf_pct?: number | null;
  calories_in: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  est_active_burn: number;
  sedentary_tdee: number;
  formula_tdee: number | null;
  cico_tdee: number | null;
  net_deficit: number;
  drinks_consumed?: number;
  habit_qty?: number;
  caffeine_mg?: number;
  sleep_bedtime?: string | null;
  sleep_waketime?: string | null;
  sleep_hours?: number | null;
  mood?: string;
  notes: string;
  habit_workout: boolean;
  habit_clean: boolean;
  habit_productivity: boolean;
  habit_sleep: boolean;
  habit_love: boolean;
  habit_custom: boolean;
}

export interface RunningTotals {
  date: string;
  calories_in: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  protein_target: number;
  protein_pct: number;
  carbs_target: number;
  fat_target: number;
  fiber_target: number;
  calorie_target: number;
  weight_lbs?: number;
  sleep_hours?: number | null;
  meal_count: number;
  phase_type?: 'cut' | 'maintenance' | 'bulk' | null;
  phase_day?: number | null;
  phase_total_days?: number | null;
  in_refeed?: boolean;
  refeed_day?: number | null;
  refeed_total_days?: number | null;
}

export function listDaily(startDate?: string, endDate?: string, limit = 30): Promise<DailySummaryResponse[]> {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate);
  if (endDate) params.set('end_date', endDate);
  params.set('limit', limit.toString());
  return apiFetch(`/daily?${params}`);
}

export function getRunningTotals(): Promise<RunningTotals> {
  return apiFetch('/daily/today');
}

export interface DashboardStatsResponse {
  meal_streak: number;
  workout_streak: number;
  weekly_push: number;
  weekly_pull: number;
  weekly_legs: number;
  weekly_workouts_total: number;
  weekly_deficit: number;
  avg_weight_7d: number | null;
  today_workout_target: string | null;
  // New KPI fields
  weight_sparkline: (number | null)[];
  deficit_sparkline: number[];
  sleep_sparkline: (number | null)[];
  current_weight: number | null;
  weight_goal: number | null;
  weight_lost_total: number | null;
  weight_remaining: number | null;
  tdee_cico: number | null;
  tdee_sedentary: number | null;
  sleep_avg_7d: number | null;
  sleep_bedtime: string | null;
  sleep_waketime: string | null;
  deficit_lbs_weekly: number | null;
  resting_hr: number | null;
  resting_hr_avg_7d: number | null;
  rhr_sparkline: (number | null)[];
  hrv_ms: number | null;
  hrv_avg_7d: number | null;
  hrv_sparkline: (number | null)[];
}

export function getDashboardStats(): Promise<DashboardStatsResponse> {
  return apiFetch('/daily/dashboard-stats');
}

export interface TDEEInfoResponse {
  tdee: number
  source: 'formula' | 'cico'
  formula_tdee: number | null
  cico_tdee: number | null
  n_days: number
  is_stable: boolean
  confidence: number
}

export function getTDEEInfo(): Promise<TDEEInfoResponse> {
  return apiFetch('/daily/tdee');
}

export interface DailySummaryUpdate {
  weight_lbs?: number | null;
  bf_pct?: number | null;
  workout_type?: 'Push' | 'Pull' | 'Legs' | 'Cardio' | 'Mixed' | null;
  est_active_burn?: number | null;
  sedentary_tdee?: number | null;
  drinks_consumed?: number | null;
  habit_qty?: number | null;
  caffeine_mg?: number | null;
  sleep_bedtime?: string | null;
  sleep_waketime?: string | null;
  sleep_hours?: number | null;
  mood?: string | null;
  notes?: string | null;
  habit_workout?: boolean | null;
  habit_clean?: boolean | null;
  habit_productivity?: boolean | null;
  habit_sleep?: boolean | null;
  habit_love?: boolean | null;
  habit_custom?: boolean | null;
}

export function updateDaily(date: string, data: DailySummaryUpdate): Promise<DailySummaryResponse> {
  return apiFetch(`/daily/${date}`, { method: 'PUT', body: JSON.stringify(data) });
}

export interface HabitMeta { label: string; emoji: string; unit: string }
export const DEFAULT_HABIT_META: HabitMeta = { label: 'Habit', emoji: '✳️', unit: 'g' };
export interface HabitsConfig { meta: HabitMeta; descriptions: Record<string, string> }

export async function getHabitsConfig(): Promise<HabitsConfig> {
  const raw = await apiFetch('/daily/habits/config') as Record<string, { description?: string }> & { _meta?: HabitMeta };
  const { _meta, ...entries } = raw;
  return {
    meta: _meta ?? DEFAULT_HABIT_META,
    descriptions: Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, v?.description ?? ''])
    ),
  };
}

// ==========================================
// Advisor
// ==========================================

export interface WorkoutPlanExercise {
  name: string;
  warm_up?: string | null;
  weights: string[];
  sets: string[];
  previous_date?: string | null;
  previous_weight?: string | null;
  previous_reps?: string | null;
  overload_note: string;
}

export interface WorkoutPlan {
  workout_type: string;
  date_label: string;
  exercises: WorkoutPlanExercise[];
  session_notes: { duration: string; cardio: string; caveats: string };
}

// Submit returns a job_id immediately; poll /jobs/{id} for the plan. Workout
// planning is a long LLM call; running it synchronously timed out the origin
// behind Cloudflare (524). See pollJobStatus.
export function planWorkoutAsync(dayType?: string, notes?: string): Promise<AsyncJobSubmitResponse> {
  return apiFetch('/advisor/plan-workout/async', {
    method: 'POST',
    body: JSON.stringify({ day_type: dayType, notes }),
  });
}

export function getChatHistory(limit = 50): Promise<Array<{ role: string; content: string; created_at: string }>> {
  return apiFetch(`/advisor/history?limit=${limit}`);
}

// ==========================================
// Phases
// ==========================================

export type PhaseType = 'cut' | 'maintenance' | 'bulk';

export interface RefeedResponse {
  id: number;
  phase_id: number;
  start_date: string;          // YYYY-MM-DD
  end_date: string;
  target_calories: number;
  target_protein_g: number;
  target_carbs_g: number;
  target_fat_g: number;
  target_fiber_g: number;
  notes?: string | null;
}

export interface RefeedCreate {
  start_date: string;
  end_date: string;
  target_calories: number;
  target_protein_g: number;
  target_carbs_g: number;
  target_fat_g: number;
  target_fiber_g: number;
  notes?: string | null;
}

export type RefeedUpdate = Partial<RefeedCreate>;

export interface PhaseResponse {
  id: number;
  phase_type: PhaseType;
  start_date: string;
  end_date: string | null;
  target_calories: number;
  target_protein_g: number;
  target_carbs_g: number;
  target_fat_g: number;
  target_fiber_g: number;
  target_weight_lbs: number | null;
  notes?: string | null;
  refeeds: RefeedResponse[];
}

export interface PhaseCreate {
  phase_type: PhaseType;
  start_date: string;
  end_date?: string | null;
  target_calories: number;
  target_protein_g: number;
  target_carbs_g: number;
  target_fat_g: number;
  target_fiber_g: number;
  target_weight_lbs?: number | null;
  notes?: string | null;
}

export type PhaseUpdate = Partial<PhaseCreate>;

export interface CurrentPhaseResponse {
  phase: PhaseResponse | null;
  active_refeed: RefeedResponse | null;
  day_of_phase: number | null;
  total_phase_days: number | null;
  refeed_day: number | null;
  refeed_total_days: number | null;
}

export function listPhases(): Promise<PhaseResponse[]> {
  return apiFetch('/phases');
}

export function getCurrentPhase(): Promise<CurrentPhaseResponse> {
  return apiFetch('/phases/current');
}

export function createPhase(data: PhaseCreate): Promise<PhaseResponse> {
  return apiFetch('/phases', { method: 'POST', body: JSON.stringify(data) });
}

export function updatePhase(id: number, data: PhaseUpdate): Promise<PhaseResponse> {
  return apiFetch(`/phases/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deletePhase(id: number): Promise<void> {
  return apiFetch(`/phases/${id}`, { method: 'DELETE' });
}

export function createRefeed(phaseId: number, data: RefeedCreate): Promise<RefeedResponse> {
  return apiFetch(`/phases/${phaseId}/refeeds`, { method: 'POST', body: JSON.stringify(data) });
}

export function updateRefeed(id: number, data: RefeedUpdate): Promise<RefeedResponse> {
  return apiFetch(`/phases/refeeds/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteRefeed(id: number): Promise<void> {
  return apiFetch(`/phases/refeeds/${id}`, { method: 'DELETE' });
}

export interface WeightProjectionResponse {
  target_value: number;
  current_value: number | null;
  starting_value: number | null;
  projected_date: string | null;
  pace_per_week: number | null;
  days_remaining: number | null;
}

export function getWeightProjection(phaseId: number, windowDays?: number): Promise<WeightProjectionResponse> {
  const qs = windowDays != null ? `?window_days=${windowDays}` : '';
  return apiFetch(`/phases/${phaseId}/weight-projection${qs}`);
}

// ==========================================
// Progress Photos
// ==========================================

export interface ProgressPhotoResponse {
  id: number;
  date: string;
  filename: string;
  created_at: string;
}

export function uploadPhoto(date: string, file: File): Promise<ProgressPhotoResponse> {
  const formData = new FormData();
  formData.append('file', file);
  return fetch(`${API_BASE}/photos/upload?date=${encodeURIComponent(date)}`, {
    method: 'POST',
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body: formData,
  }).then(async res => {
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
  });
}

export function listPhotos(): Promise<ProgressPhotoResponse[]> {
  return apiFetch('/photos');
}

export async function fetchPhotoBlob(date: string): Promise<string> {
  const res = await fetch(`${API_BASE}/photos/${encodeURIComponent(date)}/image`, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  if (!res.ok) throw new Error(`Photo fetch failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function deletePhoto(date: string): Promise<void> {
  return apiFetch(`/photos/${encodeURIComponent(date)}`, { method: 'DELETE' });
}


// ==========================================
// Tasks (Kanban board)
// ==========================================

export interface TaskResponse {
  id: number;
  title: string;
  category: string;
  status: string;
  priority: string | null;
  due_date: string | null;
  notes: string | null;
  position: number;
  created_at: string;
  completed_at: string | null;
}

export interface TaskCreate {
  title: string;
  category?: string;
  status?: string;
  priority?: string | null;
  due_date?: string | null;
  notes?: string | null;
}

export interface TaskUpdate {
  title?: string;
  category?: string;
  priority?: string | null;
  due_date?: string | null;
  notes?: string | null;
}

export interface TaskMoveRequest {
  status: string;
  position: number;
}

export interface TaskAdvisorChatResponse {
  response: string;
  created_tasks: TaskResponse[];
}

export function listTasks(status?: string, category?: string): Promise<TaskResponse[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (category) params.set('category', category);
  const qs = params.toString();
  return apiFetch(`/tasks${qs ? '?' + qs : ''}`);
}

export function createTask(data: TaskCreate): Promise<TaskResponse> {
  return apiFetch('/tasks', { method: 'POST', body: JSON.stringify(data) });
}

export function updateTask(id: number, data: TaskUpdate): Promise<TaskResponse> {
  return apiFetch(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteTask(id: number): Promise<void> {
  return apiFetch(`/tasks/${id}`, { method: 'DELETE' });
}

export function moveTask(id: number, data: TaskMoveRequest): Promise<TaskResponse> {
  return apiFetch(`/tasks/${id}/move`, { method: 'PUT', body: JSON.stringify(data) });
}

export function listTaskCategories(): Promise<string[]> {
  return apiFetch('/tasks/categories');
}

export function taskChatAsync(message: string): Promise<AsyncJobSubmitResponse> {
  return apiFetch('/tasks/chat/async', { method: 'POST', body: JSON.stringify({ message }) });
}

export interface OverdueTask {
  id: number;
  title: string;
  category: string;
  due_date: string | null;
  days_overdue: number;
  priority: string | null;
}

export function getOverdueTasks(): Promise<OverdueTask[]> {
  return apiFetch('/tasks/overdue');
}

export interface ImportantDateResponse {
  name: string;        // "Mom", "Dave & Sara wedding"
  category: string;    // "birthday" | "anniversary" | "event"
  emoji: string;       // chosen by the backend (🎂 / 💍 / ⭐ / 📅)
  date: string;        // ISO "YYYY-MM-DD" of the next occurrence
  days_until: number;  // >= 0
}

export function getUpcomingDates(window = 30): Promise<ImportantDateResponse[]> {
  return apiFetch(`/important-dates/upcoming?window=${window}`);
}


// ==========================================
// Companies (Job Search)
// ==========================================

export interface CompanyResponse {
  id: number;
  name: string;
  tier: string;
  location: string | null;
  notes: string | null;
  role_types: string | null;
  careers_url: string | null;
  website_url: string | null;
  market_info: string | null;
  market_info_updated_at: string | null;
  created_at: string;
}

export interface CompanyCreate {
  name: string;
  tier: string;
  location?: string | null;
  notes?: string | null;
  role_types?: string | null;
  careers_url?: string | null;
  website_url?: string | null;
}

export interface CompanyUpdate {
  name?: string;
  tier?: string;
  location?: string | null;
  notes?: string | null;
  role_types?: string | null;
  careers_url?: string | null;
  website_url?: string | null;
  market_info?: string | null;
}

export function listCompanies(): Promise<CompanyResponse[]> {
  return apiFetch('/companies');
}

export function createCompany(data: CompanyCreate): Promise<CompanyResponse> {
  return apiFetch('/companies', { method: 'POST', body: JSON.stringify(data) });
}

export function updateCompany(id: number, data: CompanyUpdate): Promise<CompanyResponse> {
  return apiFetch(`/companies/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteCompany(id: number): Promise<void> {
  return apiFetch(`/companies/${id}`, { method: 'DELETE' });
}

export interface CompanyResearch {
  summary: string;
  company_size: string | null;
  engineering_size: string | null;
  funding_stage: string | null;
  tech_stack: string[] | null;
  culture_notes: string[] | null;
  recent_layoffs: string | null;
  glassdoor_rating: string | null;
  hiring_signals: string | null;
  recent_news: string | null;
  stock_performance: string | null;
  careers_page_url: string | null;
  last_updated: string;
}

export interface CompanyResearchResponse {
  company: CompanyResponse;
  research: CompanyResearch;
}

export interface CompanyAdvisorChatResponse {
  response: string;
  added_companies: CompanyResponse[];
  updated_companies: CompanyResponse[];
  removed_company_ids: number[];
}

export function companyResearchAsync(id: number): Promise<AsyncJobSubmitResponse> {
  return apiFetch(`/companies/${id}/research/async`, { method: 'POST' });
}

export function companyChatAsync(message: string): Promise<AsyncJobSubmitResponse> {
  return apiFetch('/companies/chat/async', { method: 'POST', body: JSON.stringify({ message }) });
}

export function getCompanyChatHistory(limit = 50): Promise<Array<{ role: string; content: string; created_at: string }>> {
  return apiFetch(`/companies/chat/history?limit=${limit}`);
}


// ==========================================
// Applications (Job Search)
// ==========================================

export interface ApplicationEventResponse {
  id: number;
  status: string;
  note: string | null;
  created_at: string;
}

export interface ApplicationResponse {
  id: number;
  company_id: number | null;
  company_name: string;
  job_title: string;
  status: string;
  salary_range: string | null;
  recruiter_name: string | null;
  posting_url: string | null;
  notes: string | null;
  applied_date: string | null;
  created_at: string;
  updated_at: string | null;
  events: ApplicationEventResponse[];
}

export interface ApplicationCreate {
  company_id?: number | null;
  company_name: string;
  job_title: string;
  status?: string;
  salary_range?: string | null;
  recruiter_name?: string | null;
  posting_url?: string | null;
  notes?: string | null;
}

export interface ApplicationUpdate {
  company_name?: string;
  job_title?: string;
  status?: string;
  salary_range?: string | null;
  recruiter_name?: string | null;
  posting_url?: string | null;
  notes?: string | null;
}

export interface ApplicationStats {
  total: number;
  active: number;
  by_status: Record<string, number>;
  response_rate: number;
}

export interface ApplicationAdvisorChatResponse {
  response: string;
  created_applications: ApplicationResponse[];
  updated_applications: ApplicationResponse[];
}

export function listApplications(status?: string, includeEvents = false): Promise<ApplicationResponse[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (includeEvents) params.set('include_events', 'true');
  const qs = params.toString();
  return apiFetch(`/applications${qs ? '?' + qs : ''}`);
}

export function getApplication(id: number): Promise<ApplicationResponse> {
  return apiFetch(`/applications/${id}`);
}

export function createApplication(data: ApplicationCreate): Promise<ApplicationResponse> {
  return apiFetch('/applications', { method: 'POST', body: JSON.stringify(data) });
}

export function updateApplication(id: number, data: ApplicationUpdate): Promise<ApplicationResponse> {
  return apiFetch(`/applications/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteApplication(id: number): Promise<void> {
  return apiFetch(`/applications/${id}`, { method: 'DELETE' });
}

export function getApplicationStats(): Promise<ApplicationStats> {
  return apiFetch('/applications/stats');
}

export function applicationChatAsync(message: string): Promise<AsyncJobSubmitResponse> {
  return apiFetch('/applications/chat/async', { method: 'POST', body: JSON.stringify({ message }) });
}

export function getApplicationChatHistory(limit = 50): Promise<Array<{ role: string; content: string; created_at: string }>> {
  return apiFetch(`/applications/chat/history?limit=${limit}`);
}


// ==========================================
// Leetcode
// ==========================================

export interface LeetcodeProblemResponse {
  id: number;
  name: string;
  number: number | null;
  url: string | null;
  category: string;
  difficulty: string;
  status: string;
  solved_without_help: boolean;
  notes: string | null;
  created_at: string;
  solved_at: string | null;
  neetcode_order: number | null;
}

export interface LeetcodeProblemCreate {
  name: string;
  number?: number | null;
  url?: string | null;
  category: string;
  difficulty: string;
  status?: string;
  solved_without_help?: boolean;
  notes?: string | null;
}

export interface LeetcodeProblemUpdate {
  name?: string;
  number?: number | null;
  url?: string | null;
  category?: string;
  difficulty?: string;
  status?: string;
  solved_without_help?: boolean;
  notes?: string | null;
}

export interface LeetcodeStats {
  total: number;
  solved: number;
  attempted: number;
  solved_without_help: number;
  by_category: Record<string, { total: number; solved: number; attempted: number }>;
  by_difficulty: Record<string, { total: number; solved: number }>;
  streak: number;
}

export interface LeetcodeAdvisorChatResponse {
  response: string;
  created_problems: LeetcodeProblemResponse[];
}

export function listLeetcodeProblems(params?: { category?: string; difficulty?: string; status?: string }): Promise<LeetcodeProblemResponse[]> {
  const p = new URLSearchParams();
  if (params?.category) p.set('category', params.category);
  if (params?.difficulty) p.set('difficulty', params.difficulty);
  if (params?.status) p.set('status', params.status);
  const qs = p.toString();
  return apiFetch(`/leetcode${qs ? '?' + qs : ''}`);
}

export function createLeetcodeProblem(data: LeetcodeProblemCreate): Promise<LeetcodeProblemResponse> {
  return apiFetch('/leetcode', { method: 'POST', body: JSON.stringify(data) });
}

export function updateLeetcodeProblem(id: number, data: LeetcodeProblemUpdate): Promise<LeetcodeProblemResponse> {
  return apiFetch(`/leetcode/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteLeetcodeProblem(id: number): Promise<void> {
  return apiFetch(`/leetcode/${id}`, { method: 'DELETE' });
}

export function getLeetcodeStats(): Promise<LeetcodeStats> {
  return apiFetch('/leetcode/stats');
}

export function leetcodeChatAsync(message: string, problemId?: number): Promise<AsyncJobSubmitResponse> {
  const body: Record<string, unknown> = { message };
  if (problemId != null) body.problem_id = problemId;
  return apiFetch('/leetcode/chat/async', { method: 'POST', body: JSON.stringify(body) });
}

export function getLeetcodeChatHistory(problemId?: number, limit = 50): Promise<Array<{ role: string; content: string; created_at: string }>> {
  const params = new URLSearchParams();
  params.set('limit', limit.toString());
  if (problemId != null) params.set('problem_id', problemId.toString());
  return apiFetch(`/leetcode/chat/history?${params}`);
}

export interface UpNextRecommendation {
  problem: LeetcodeProblemResponse;
  reason: string;
}

export interface UpNextResponse {
  recommendations: UpNextRecommendation[];
}

export function seedNeetcode150(): Promise<{ seeded: number; updated: number }> {
  return apiFetch('/leetcode/seed', { method: 'POST' });
}

export function getUpNext(focus?: string): Promise<UpNextResponse> {
  const params = new URLSearchParams();
  if (focus) params.set('focus', focus);
  const qs = params.toString();
  return apiFetch(`/leetcode/up-next${qs ? '?' + qs : ''}`);
}

// ==========================================
// Schedule — Template Blocks
// ==========================================

export interface TemplateBlockResponse {
  id: number;
  name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  category: string;
  color: string;
}

export interface TemplateBlockCreate {
  name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  category?: string;
  color?: string;
}

export interface TemplateBlockUpdate {
  name?: string;
  day_of_week?: number;
  start_time?: string;
  end_time?: string;
  category?: string;
  color?: string;
}

// ==========================================
// Schedule — Time Blocks
// ==========================================

export interface TimeBlockResponse {
  id: number;
  date: string;
  name: string;
  start_time: string;
  end_time: string;
  category: string;
  color: string;
  status: string;
  task_id: number | null;
  template_block_id: number | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  auto_status: string | null;
  auto_detail: string | null;
  task_title: string | null;
  task_status: string | null;
}

export interface TimeBlockCreate {
  date: string;
  name: string;
  start_time: string;
  end_time: string;
  category?: string;
  color?: string;
  status?: string;
  task_id?: number | null;
  template_block_id?: number | null;
  notes?: string | null;
}

export interface TimeBlockUpdate {
  name?: string;
  date?: string;
  start_time?: string;
  end_time?: string;
  category?: string;
  color?: string;
  status?: string;
  task_id?: number | null;
  notes?: string | null;
}

export interface WeeklyReviewResponse {
  adherence_pct: number;
  total_blocks: number;
  done_blocks: number;
  skipped_blocks: number;
  planned_hours: number;
  completed_hours: number;
  by_category: Record<string, { done: number; total: number }>;
  skipped_list: Array<{ date: string; name: string; duration_hrs: number }>;
  trend: Array<{ week: string; week_start: string; adherence_pct: number }>;
}

// ==========================================
// Schedule API Functions
// ==========================================

export function listTemplateBlocks(): Promise<TemplateBlockResponse[]> {
  return apiFetch('/schedule/templates');
}

export function createTemplateBlock(data: TemplateBlockCreate): Promise<TemplateBlockResponse> {
  return apiFetch('/schedule/templates', { method: 'POST', body: JSON.stringify(data) });
}

export function updateTemplateBlock(id: number, data: TemplateBlockUpdate): Promise<TemplateBlockResponse> {
  return apiFetch(`/schedule/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteTemplateBlock(id: number): Promise<void> {
  return apiFetch(`/schedule/templates/${id}`, { method: 'DELETE' });
}

export function applyTemplate(weekStart: string): Promise<TimeBlockResponse[]> {
  return apiFetch('/schedule/templates/apply', {
    method: 'POST',
    body: JSON.stringify({ week_start_date: weekStart }),
  });
}

export function listTimeBlocks(weekStart: string): Promise<TimeBlockResponse[]> {
  return apiFetch(`/schedule/blocks?week_start=${weekStart}`);
}

export function createTimeBlock(data: TimeBlockCreate): Promise<TimeBlockResponse> {
  return apiFetch('/schedule/blocks', { method: 'POST', body: JSON.stringify(data) });
}

export function updateTimeBlock(id: number, data: TimeBlockUpdate): Promise<TimeBlockResponse> {
  return apiFetch(`/schedule/blocks/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteTimeBlock(id: number): Promise<void> {
  return apiFetch(`/schedule/blocks/${id}`, { method: 'DELETE' });
}

export function clearWeekBlocks(weekStart: string): Promise<{ ok: boolean; deleted: number }> {
  return apiFetch(`/schedule/blocks/week?week_start=${weekStart}`, { method: 'DELETE' });
}

export function getWeeklyReview(weekStart: string): Promise<WeeklyReviewResponse> {
  return apiFetch(`/schedule/blocks/review?week_start=${weekStart}`);
}

// ==========================================
// Recipe Bank
// ==========================================

export interface RecipeIngredientData {
  name: string;
  amount: number | null;
  unit: string | null;
  original_unit: string | null;
  category: string | null;
  exotic: boolean;
  sort_order: number;
}

export interface RecipeIngredientResponse extends RecipeIngredientData {
  id: number;
}

export interface CookLogData {
  date: string;
  guests?: number | null;
  scale_factor?: number;
  notes?: string | null;
  rating?: number | null;
  rating_comment?: string | null;
}

export interface CookLogResponse {
  id: number;
  recipe_id: number;
  date: string;
  guests: number | null;
  scale_factor: number;
  notes: string | null;
  rating: number | null;
  rating_comment: string | null;
  created_at: string | null;
  cooked_by?: string | null;
  photo_filenames: string[];
  reactions: ReactionAggregate[];
  comments: CommentResponse[];
  recipe_name?: string | null;
}

export interface ReactionAggregate {
  emoji: string;
  count: number;
  users: string[];
}

export interface CommentResponse {
  id: number;
  text: string;
  username: string | null;
  created_at: string | null;
}

export interface FeedResponse {
  items: CookLogResponse[];
  has_more: boolean;
}

export interface RecipeResponse {
  id: number;
  name: string;
  source_url: string | null;
  instructions: string;
  notes: string | null;
  rating: number | null;
  servings: number | null;
  feeds: number | null;
  prep_ahead: boolean;
  tags: string | null;
  image_filename: string | null;
  created_at: string | null;
  updated_at: string | null;
  added_by?: string | null;
  ingredients: RecipeIngredientResponse[];
  cook_logs: CookLogResponse[];
}

export interface RecipeListResponse {
  id: number;
  name: string;
  rating: number | null;
  tags: string | null;
  servings: number | null;
  feeds: number | null;
  prep_ahead: boolean;
  image_filename: string | null;
  created_at: string | null;
  updated_at: string | null;
  cook_count: number;
  last_cooked: string | null;
  added_by?: string | null;
  cook_photos: string[];
}

export interface RecipeCreate {
  name: string;
  source_url?: string | null;
  instructions: string;
  notes?: string | null;
  servings?: number | null;
  feeds?: number | null;
  prep_ahead?: boolean;
  tags?: string | null;
  ingredients: RecipeIngredientData[];
}

export interface RecipeUpdate {
  name?: string;
  source_url?: string | null;
  instructions?: string;
  notes?: string | null;
  servings?: number | null;
  feeds?: number | null;
  prep_ahead?: boolean;
  tags?: string | null;
  ingredients?: RecipeIngredientData[];
}

export interface ScaledIngredient {
  name: string;
  amount: number | null;
  unit: string | null;
  original_unit: string | null;
  category: string | null;
  exotic: boolean;
  sort_order: number;
  original_amount: number | null;
}

export function listRecipes(params?: {
  search?: string;
  tags?: string;
  min_rating?: number;
  sort_by?: string;
}): Promise<RecipeListResponse[]> {
  const qs = new URLSearchParams();
  if (params?.search) qs.set('search', params.search);
  if (params?.tags) qs.set('tags', params.tags);
  if (params?.min_rating !== undefined) qs.set('min_rating', String(params.min_rating));
  if (params?.sort_by) qs.set('sort_by', params.sort_by);
  const q = qs.toString();
  return apiFetch(`/recipes${q ? '?' + q : ''}`);
}

export function getRecipe(id: number): Promise<RecipeResponse> {
  return apiFetch(`/recipes/${id}`);
}

export function createRecipe(data: RecipeCreate): Promise<RecipeResponse> {
  return apiFetch('/recipes', { method: 'POST', body: JSON.stringify(data) });
}

export function updateRecipe(id: number, data: RecipeUpdate): Promise<RecipeResponse> {
  return apiFetch(`/recipes/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteRecipe(id: number): Promise<void> {
  return apiFetch(`/recipes/${id}`, { method: 'DELETE' });
}

export function listRecipeTags(): Promise<string[]> {
  return apiFetch('/recipes/tags');
}

export function createCookLog(recipeId: number, data: CookLogData): Promise<CookLogResponse> {
  return apiFetch(`/recipes/${recipeId}/cook`, { method: 'POST', body: JSON.stringify(data) });
}

export function updateCookLog(recipeId: number, cookId: number, data: Partial<CookLogData>): Promise<CookLogResponse> {
  return apiFetch(`/recipes/${recipeId}/cook/${cookId}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteCookLog(recipeId: number, cookId: number): Promise<void> {
  return apiFetch(`/recipes/${recipeId}/cook/${cookId}`, { method: 'DELETE' });
}

export async function uploadCookLogPhoto(recipeId: number, cookId: number, file: File): Promise<{ ok: boolean; filename: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/recipes/${recipeId}/cook/${cookId}/photos`, {
    method: 'POST',
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}

export function getCookLogPhotoUrl(filename: string, thumb: boolean = false): string {
  return `${API_BASE}/recipes/cook-photos/${filename}${thumb ? '?thumb=1' : ''}`;
}

export function deleteCookLogPhoto(recipeId: number, cookId: number, filename: string): Promise<void> {
  return apiFetch(`/recipes/${recipeId}/cook/${cookId}/photos/${filename}`, { method: 'DELETE' });
}

export function getFeed(page: number = 1, limit: number = 20): Promise<FeedResponse> {
  return apiFetch(`/recipes/feed?page=${page}&limit=${limit}`);
}

export function toggleReaction(recipeId: number, cookId: number, emoji: string): Promise<CookLogResponse> {
  return apiFetch(`/recipes/${recipeId}/cook/${cookId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
}

export function addComment(recipeId: number, cookId: number, text: string): Promise<CookLogResponse> {
  return apiFetch(`/recipes/${recipeId}/cook/${cookId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function deleteComment(recipeId: number, cookId: number, commentId: number): Promise<void> {
  return apiFetch(`/recipes/${recipeId}/cook/${cookId}/comments/${commentId}`, { method: 'DELETE' });
}

export function scaleIngredients(recipeId: number, servings: number): Promise<ScaledIngredient[]> {
  return apiFetch(`/recipes/${recipeId}/scale?servings=${servings}`);
}

export async function uploadRecipePhoto(recipeId: number, file: File): Promise<{ ok: boolean; filename: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/recipes/${recipeId}/photo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

export function getRecipePhotoUrl(recipeId: number, thumb: boolean = false): string {
  return `${API_BASE}/recipes/${recipeId}/photo${thumb ? '?thumb=1' : ''}`;
}

export async function fetchRecipePhotoBlob(recipeId: number, thumb: boolean = false): Promise<string> {
  const res = await fetch(`${API_BASE}/recipes/${recipeId}/photo${thumb ? '?thumb=1' : ''}`, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  if (!res.ok) throw new Error(`Recipe photo fetch failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function deleteRecipePhoto(recipeId: number): Promise<void> {
  return apiFetch(`/recipes/${recipeId}/photo`, { method: 'DELETE' });
}

export function parseRecipeUrlAsync(url: string, instructions?: string): Promise<AsyncJobSubmitResponse> {
  return apiFetch('/recipes/parse-url/async', { method: 'POST', body: JSON.stringify({ url, instructions: instructions || null }) });
}

export function parseRecipeTextAsync(text: string, sourceUrl?: string, instructions?: string): Promise<AsyncJobSubmitResponse> {
  return apiFetch('/recipes/parse-text/async', { method: 'POST', body: JSON.stringify({ text, source_url: sourceUrl || null, instructions: instructions || null }) });
}

// ==========================================
// Shopping List
// ==========================================

export interface ShoppingListItem {
  id: number;
  name: string;
  amount: number | null;
  unit: string | null;
  category: string;
  recipe_id: number | null;
  recipe_name: string | null;
  checked: boolean;
  exotic: boolean;
  sort_order: number;
  created_at: string;
}

export interface ShoppingListItemCreate {
  name: string;
  amount?: number;
  unit?: string;
  category?: string;
  recipe_id?: number;
  recipe_name?: string;
  exotic?: boolean;
}

export interface ShoppingListItemUpdate {
  name?: string;
  amount?: number;
  unit?: string;
  category?: string;
  checked?: boolean;
}

export function listShoppingItems(): Promise<ShoppingListItem[]> {
  return apiFetch('/shopping-list');
}

export interface ClassifyAsyncResponse {
  cached: Record<string, string>;
  job_id: string | null;
}

/** Cache-first batch classify. Cache hits come back immediately in `cached`;
 * if `job_id` is set, poll the `ingredient_classify` context for the misses. */
export function classifyIngredientsAsync(names: string[]): Promise<ClassifyAsyncResponse> {
  return apiFetch('/shopping-list/classify/async', {
    method: 'POST',
    body: JSON.stringify({ names }),
  });
}

export function addShoppingItem(item: ShoppingListItemCreate): Promise<ShoppingListItem> {
  return apiFetch('/shopping-list', {
    method: 'POST',
    body: JSON.stringify(item),
  });
}

export function addRecipeToShoppingList(recipeId: number, scale: number = 1.0): Promise<ShoppingListItem[]> {
  return apiFetch(`/shopping-list/from-recipe/${recipeId}?scale=${scale}`, {
    method: 'POST',
  });
}

export function updateShoppingItem(id: number, update: ShoppingListItemUpdate): Promise<ShoppingListItem> {
  return apiFetch(`/shopping-list/${id}`, {
    method: 'PUT',
    body: JSON.stringify(update),
  });
}

export function deleteShoppingItem(id: number): Promise<void> {
  return apiFetch(`/shopping-list/${id}`, { method: 'DELETE' });
}

export function clearCompletedShoppingItems(): Promise<void> {
  return apiFetch('/shopping-list/completed', { method: 'DELETE' });
}

export function clearAllShoppingItems(): Promise<void> {
  return apiFetch('/shopping-list/all', { method: 'DELETE' });
}

// ==========================================
// Settings (Admin)
// ==========================================

export interface HelmSettings {
  settings: Record<string, string>;
  options: Record<string, string[]>;
}

export function fetchSettings(): Promise<HelmSettings> {
  return apiFetch('/settings');
}

export function updateSettings(updates: Record<string, string | boolean>): Promise<{ updated: Record<string, string>; settings: Record<string, string> }> {
  return apiFetch('/settings', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

// ===========================================================================
// Google Health
// ===========================================================================
export interface HealthConnectionStatus {
  status: 'connected' | 'disconnected' | 'needs_reconsent';
  last_sync_at: string | null;
  last_error: string | null;
  scopes: string | null;
}

export interface HealthSyncResult {
  status: string;
  last_sync_at: string | null;
  steps_today: number | null;
}

export function getHealthStatus(): Promise<HealthConnectionStatus> {
  return apiFetch('/health/status');
}

export async function connectHealth(): Promise<void> {
  const { authorize_url } = await apiFetch<{ authorize_url: string }>('/health/connect');
  window.location.href = authorize_url;
}

export function syncHealthNow(): Promise<HealthSyncResult> {
  return apiFetch('/health/sync', { method: 'POST' });
}

export function disconnectHealth(): Promise<{ status: string }> {
  return apiFetch('/health/disconnect', { method: 'POST' });
}

// ===== Google Health data =====
export interface DailyHealthResponse {
  date: string;
  steps: number | null;
  resting_hr: number | null;
  hrv_ms: number | null;
  respiratory_rate: number | null;
  sleep_deep_min: number | null;
  sleep_light_min: number | null;
  sleep_rem_min: number | null;
  sleep_awake_min: number | null;
  sleep_efficiency_pct: number | null;
}

export interface IntradayHeartRateResponse {
  date: string;
  points: { t: string; bpm: number }[];
  min_bpm: number | null;
  avg_bpm: number | null;
  max_bpm: number | null;
}

export function getHealthDaily(start: string, end: string): Promise<DailyHealthResponse[]> {
  return apiFetch(`/health/daily?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
}

export function getIntradayHeartRate(date: string): Promise<IntradayHeartRateResponse> {
  return apiFetch(`/health/intraday/heart-rate?date=${encodeURIComponent(date)}`);
}

// ── Workout-log assembly (activities spine) ────────────────────────────────
export interface ActivityResponse {
  id: number;                  // real activities-table PK
  label: string;
  category: string;            // strength | cardio (derived server-side)
  activity: string;            // strength | swim | run | bike | …
  google_session_id: number | null;
  start: string | null;        // "HH:MM"
  end: string | null;          // "HH:MM"
  duration_min: number | null;
  avg_hr: number | null;
  laps: number | null;
  distance_m: number | null;
  pace_s_per_km: number | null;
  calories_kcal: number | null;
  credited_kcal: number | null;
  elevation_gain_m: number | null;
  avg_cadence_spm: number | null;
  has_route: boolean;
  notes: string | null;        // activity-level notes (row-less cardio)
  exercises: WorkoutResponse[];
}

/** Transitional alias — components migrate to ActivityResponse in place. */
export type LogSession = ActivityResponse;

export interface DayLog {
  date: string;
  day_type?: 'Push' | 'Pull' | 'Legs' | 'Cardio' | 'Mixed' | null;
  exercise_count: number;
  total_sets: number;
  total_volume: number;
  is_cardio: boolean;
  sessions: ActivityResponse[];
}

export interface SessionHistoryRow {
  date: string;
  duration_min: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  laps?: number | null;
  distance_m?: number | null;
  pace_s_per_km?: number | null;
  notes?: string | null;
}

export interface SessionHeartRateResponse {
  session_id: number;
  date: string;
  points: { t: string; bpm: number }[];
  min_bpm: number | null;
  avg_bpm: number | null;
  max_bpm: number | null;
  zones?: { fat_burn?: number; cardio?: number; peak?: number } | null;  // personalized HR-zone floors
}

export function getWorkoutLog(start?: string, end?: string): Promise<DayLog[]> {
  const p = new URLSearchParams();
  if (start) p.set('start', start);
  if (end) p.set('end', end);
  const qs = p.toString();
  return apiFetch(`/workouts/log${qs ? `?${qs}` : ''}`);
}

export function getSessionHistory(activity: string, limit = 20): Promise<SessionHistoryRow[]> {
  return apiFetch(`/workouts/session-history?activity=${encodeURIComponent(activity)}&limit=${limit}`);
}

export function getSessionHeartRate(id: number): Promise<SessionHeartRateResponse> {
  return apiFetch(`/health/sessions/${id}/heart-rate`);
}

export interface RunSplitOut {
  distance_m: number;
  seconds: number;
  avg_hr: number | null;
  marker: [number, number] | null;
}

export interface RunDetailResponse {
  session_id: number;
  route: [number, number][] | null;
  splits: RunSplitOut[] | null;
  route_status: 'ok' | 'none' | 'error';
}

/** Rejects with 404 until the sync's TCX pass has stored the run's detail row. */
export function getRunDetail(id: number): Promise<RunDetailResponse> {
  return apiFetch(`/workouts/run-detail/${id}`);
}


export function triggerBackfill(): Promise<{ status: string; start_date: string | null }> {
  return apiFetch('/health/backfill', { method: 'POST' });
}
