// 讀取部署時產生的真實海況快照（public/data/ocean.json，同源、免金鑰、免 CORS）
export async function loadOceanData() {
  try {
    const base = import.meta.env.BASE_URL || '/'
    const res = await fetch(`${base}data/ocean.json`, { cache: 'no-cache' })
    if (!res.ok) return null
    const d = await res.json()
    if (!d || !d.params) return null
    return d
  } catch (e) {
    return null
  }
}
