export interface HospitalCandidate {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  phone?: string;
  distanceM?: number;
  placeUrl?: string;
}

interface KakaoDocument {
  id: string;
  place_name: string;
  address_name?: string;
  road_address_name?: string;
  category_group_code?: string;
  phone?: string;
  distance?: string;
  place_url?: string;
  x: string;
  y: string;
}

export async function findNearbyHospitals(input: {
  lat: number;
  lng: number;
  query?: string;
  radiusM?: number;
}): Promise<HospitalCandidate[]> {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) throw new Error("KAKAO_REST_API_KEY가 설정되지 않았습니다.");
  const radius = Math.min(20_000, Math.max(500, input.radiusM ?? 5_000));
  const params = new URLSearchParams({
    query: input.query?.trim() || "소아과",
    category_group_code: "HP8",
    x: String(input.lng),
    y: String(input.lat),
    radius: String(radius),
    sort: "distance",
    size: "10",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${params}`, {
      headers: { Authorization: `KakaoAK ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`카카오 병원 검색 실패 (${response.status})`);
    const data = (await response.json()) as { documents?: KakaoDocument[] };
    return (data.documents ?? [])
      .filter((item) => item.category_group_code === "HP8")
      .slice(0, 5)
      .map((item) => ({
        placeId: item.id,
        name: item.place_name,
        address: item.road_address_name || item.address_name || "주소 미제공",
        lat: Number(item.y),
        lng: Number(item.x),
        phone: item.phone || undefined,
        distanceM: item.distance ? Number(item.distance) : undefined,
        placeUrl: item.place_url || undefined,
      }));
  } finally {
    clearTimeout(timer);
  }
}
