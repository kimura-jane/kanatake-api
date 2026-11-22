
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const receivedAt = Date.now();

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers });
    }

    try {
      // === デバイス登録 ===
      if (path === "/devices" && method === "POST") {
        const { device_id } = await readBody(request);
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO devices (device_id) VALUES (?)"
        ).bind(device_id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 初回クーポン使用 ===
      if (path === "/welcome-coupon" && method === "POST") {
        const { device_id, choice } = await readBody(request);
        if (!device_id || !choice) return json({ error: "device_id and choice required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT welcome_coupon_used FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ error: "device not found" }, 404, headers);
        const claimed = await env.DB.prepare(
          "UPDATE devices SET welcome_coupon_used = 1 WHERE device_id = ? AND COALESCE(welcome_coupon_used, 0) = 0 RETURNING device_id"
        ).bind(device_id).first();
        if (!claimed) return json({ error: "already used" }, 409, headers);
        return json({ ok: true, choice }, 200, headers);
      }

      // === 初回クーポン状態確認 ===
      if (path === "/welcome-coupon/status" && method === "POST") {
        const { device_id } = await readBody(request);
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT welcome_coupon_used FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ used: false }, 200, headers);
        return json({ used: !!device.welcome_coupon_used }, 200, headers);
      }

      // ★★ 追加: 誕生月取得 (GET /birthday) ★★
      if (path === "/birthday" && method === "GET") {
        const device_id = url.searchParams.get("device_id");
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT birth_month FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ ok: true, birth_month: null }, 200, headers);
        return json({ ok: true, birth_month: toBirthMonth(device.birth_month) }, 200, headers);
      }

      // === 誕生月登録 ===
      if (path === "/birthday" && method === "POST") {
        const { device_id, birth_month } = await readBody(request);
        if (!device_id || birth_month == null) return json({ error: "device_id and birth_month required" }, 400, headers);
        // 旧アプリは "11" のような文字列を送る場合がある。整数1〜12以外（"5abc"・true等）は保存しない。
        const month = typeof birth_month === "number" ? birth_month
          : typeof birth_month === "string" && /^\d{1,2}$/.test(birth_month.trim()) ? Number(birth_month.trim())
          : NaN;
        if (!Number.isInteger(month) || month < 1 || month > 12) return json({ error: "invalid month" }, 400, headers);
        // 既に登録済みか確認 → 変更不可
        const device = await env.DB.prepare(
          "SELECT birth_month FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ error: "device not found" }, 404, headers);
        if (toBirthMonth(device.birth_month) !== null) {
          return json({ error: "birth_month already set" }, 403, headers);
        }
        await env.DB.prepare(
          "UPDATE devices SET birth_month = ? WHERE device_id = ?"
        ).bind(month, device_id).run();
        return json({ ok: true, birth_month: month }, 200, headers);
      }

      // === 誕生日クーポン状態確認 ===
      if (path === "/birthday-coupon/status" && method === "POST") {
        const { device_id } = await readBody(request);
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT birth_month, birthday_coupon_used_year FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device || !device.birth_month) return json({ registered: false }, 200, headers);
        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();
        const isBirthMonth = toBirthMonth(device.birth_month) === currentMonth;
        const alreadyUsed = device.birthday_coupon_used_year === currentYear;
        return json({
          registered: true,
          birth_month: device.birth_month,
          is_birth_month: isBirthMonth,
          available: isBirthMonth && !alreadyUsed,
          used_this_year: alreadyUsed
        }, 200, headers);
      }

      // === 誕生日クーポン使用 ===
      if (path === "/birthday-coupon" && method === "POST") {
        const { device_id, choice } = await readBody(request);
        if (!device_id || !choice) return json({ error: "device_id and choice required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT birth_month, birthday_coupon_used_year FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device || !device.birth_month) return json({ error: "birth_month not set" }, 400, headers);
        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();
        if (toBirthMonth(device.birth_month) !== currentMonth) return json({ error: "not your birth month" }, 403, headers);
        const claimed = await env.DB.prepare(
          "UPDATE devices SET birthday_coupon_used_year = ? WHERE device_id = ? AND birth_month = ? AND birthday_coupon_used_year IS NOT ? RETURNING device_id"
        ).bind(currentYear, device_id, currentMonth, currentYear).first();
        if (!claimed) return json({ error: "already used this year" }, 409, headers);
        return json({ ok: true, choice }, 200, headers);
      }

      // === FiNANCiEクーポンコード入力 ===
      if (path === "/redeem-code" && method === "POST") {
        const { device_id, code } = await readBody(request);
        if (!device_id || !code) return json({ error: "device_id and code required" }, 400, headers);
        const coupon = await env.DB.prepare("SELECT * FROM coupon_codes WHERE code = ?").bind(code).first();
        if (!coupon) return json({ error: "invalid code" }, 404, headers);
        // 新規取得の証明を同一batch内で共有する。単に「使用済みかつ同端末」では、
        // 過去の取得済みコードに対する再送で user_coupons を再作成してしまう。
        // used_at に一時的な乱数マーカーを入れ、同一トランザクション内で必ずNULLへ戻す。
        // D1 batchは全SQLを1トランザクションとして実行するため、中間値は外部に公開されない。
        const claimMarker = `pending-${crypto.randomUUID()}`;
        const outcomes = await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO user_coupons (device_id, code, name, image, prize, used_at) " +
            "SELECT ?, c.code, c.name, c.image, c.prize, ? FROM coupon_codes c " +
            "WHERE c.code = ? AND c.used = 0 " +
            "AND NOT EXISTS (SELECT 1 FROM user_coupons u WHERE u.code = c.code) " +
            "RETURNING id"
          ).bind(device_id, claimMarker, code),
          env.DB.prepare(
            "UPDATE coupon_codes SET used = 1, used_by_device = ?, " +
            "used_at = datetime('now'), redeemed_at = datetime('now') " +
            "WHERE code = ? AND used = 0 AND EXISTS (" +
            "SELECT 1 FROM user_coupons WHERE device_id = ? AND code = ? AND used_at = ?) RETURNING code"
          ).bind(device_id, code, device_id, code, claimMarker),
          env.DB.prepare(
            "UPDATE user_coupons SET used_at = NULL WHERE device_id = ? AND code = ? " +
            "AND used_at = ? AND EXISTS (SELECT 1 FROM coupon_codes " +
            "WHERE code = ? AND used = 1 AND used_by_device = ?) RETURNING id"
          ).bind(device_id, code, claimMarker, code, device_id)
        ]);
        const counts = outcomes.map(x => x.results?.length ?? 0);
        if (counts.every(n => n === 0)) return json({ error: "already used" }, 409, headers);
        if (!counts.every(n => n === 1)) {
          // この状態は正常なスキーマ下では起こらない。成功を偽装せず監視対象の500にする。
          return json({ error: "coupon claim inconsistent" }, 500, headers);
        }
        return json({ ok: true, prize: coupon.prize, name: coupon.name }, 200, headers);
      }

      if (path === "/my-coupons" && method === "GET") {
        const deviceId = url.searchParams.get("device_id");
        if (!deviceId) return json({ error: "device_id required" }, 400, headers);
        const coupons = await env.DB.prepare("SELECT id, code, name, image, prize, acquired_at, used, used_at FROM user_coupons WHERE device_id = ? ORDER BY acquired_at DESC, id DESC").bind(deviceId).all();
        return json({ coupons: coupons.results }, 200, headers);
      }
      if (path === "/use-coupon" && method === "POST") {
        const { device_id, code, coupon_id } = await readBody(request);
        if (!device_id || !code || (coupon_id != null && (!Number.isSafeInteger(coupon_id) || coupon_id < 1))) return json({ error: "invalid coupon payload" }, 400, headers);
        const result = await env.DB.prepare("UPDATE user_coupons SET used = 1, used_at = datetime('now') WHERE id = (SELECT id FROM user_coupons WHERE device_id = ? AND code = ? AND (? IS NULL OR id = ?) ORDER BY id LIMIT 1) AND COALESCE(used, 0) = 0 RETURNING id").bind(device_id, code, coupon_id ?? null, coupon_id ?? null).first();
        return result ? json({ ok: true }, 200, headers) : json({ error: "coupon not found or already used" }, 409, headers);
      }

      // === 1.4.0 GPS任意・オフライン再送対応の来店ポイント ===
      if (path === "/checkin-v2" && method === "POST") {
        const body = await readBody(request);
        const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
        const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
        const qrData = typeof body.qr_data === "string" ? body.qr_data : "";
        const scanTime = typeof body.scanned_at === "string" ? body.scanned_at : "";
        const scanDay = typeof body.scanned_date_jst === "string" ? body.scanned_date_jst : "";

        if (!deviceId || deviceId.length > 128 || !requestId || requestId.length > 128 ||
            !qrData.trim() || qrData.length > 4096) {
          return json({ error: "invalid checkin payload" }, 400, headers);
        }
        const at = new Date(scanTime);
        // 旧アプリ/他OSはミリ秒なしや +09:00 形式を送る場合がある。正規化後にJST日付を厳密検証し、
        // 保存値はUTCのISO（ミリ秒あり）に統一する。
        if (!ISO_INSTANT_RE.test(scanTime) || !Number.isFinite(at.getTime()) || getJstDate(at) !== scanDay) {
          return json({ error: "invalid scanned date" }, 400, headers);
        }
        // QR検証は次回の専用シール導入時に検討。現時点の任意QRは来店証明にならない。
        const outcome = await grantCheckinPoint(env.DB, {
          deviceId, requestId, dayJst: scanDay, scannedAt: at.toISOString(),
          policy: CHECKIN_TIME_POLICY, receivedAt,
          spotName: typeof body.spot_name === "string" ? body.spot_name.slice(0, 200) : ""
        });
        return json(outcome.body, outcome.status, headers);
      }

      // === 旧アプリ互換: GPS要件を残し、付与処理だけ一元化 ===
      if (path === "/checkin" && method === "POST") {
        const { device_id, latitude, longitude, spot_lat, spot_lng, spot_name } = await readBody(request);
        if (!device_id || latitude == null || longitude == null || spot_lat == null || spot_lng == null) {
          return json({ error: "device_id, latitude, longitude, spot_lat, spot_lng required" }, 400, headers);
        }
        const dist = getDistance(latitude, longitude, spot_lat, spot_lng);
        if (!Number.isFinite(dist) || dist > 500) {
          return json({ error: "not within 500m of today's location",
            distance: Number.isFinite(dist) ? Math.round(dist) : null }, 403, headers);
        }
        const now = new Date();
        const outcome = await grantCheckinPoint(env.DB, {
          deviceId: String(device_id), requestId: crypto.randomUUID(),
          dayJst: getJstDate(now), scannedAt: now.toISOString(),
          spotName: typeof spot_name === "string" ? spot_name.slice(0, 200) : ""
        });
        return json(outcome.body, outcome.status, headers);
      }

      // === チェックイン履歴取得 ===
      if (path === "/checkin-history" && (method === "POST" || method === "GET")) {
        const { device_id } = method === "GET" ? { device_id: url.searchParams.get("device_id") } : await readBody(request);
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const logs = await env.DB.prepare(
          "SELECT spot_name, checked_in_at FROM checkin_logs WHERE device_id = ? ORDER BY checked_in_at DESC LIMIT 50"
        ).bind(device_id).all();
        return json({ history: logs.results }, 200, headers);
      }

      // === ポイント取得 ===
      if (path === "/points" && method === "POST") {
        const { device_id } = await readBody(request);
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const points = await env.DB.prepare(
          "SELECT current_points, total_redeemed, megami_coupon_active FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();
        if (!points) return json({ current_points: 0, total_redeemed: 0, megami_coupon_active: 0 }, 200, headers);
        return json(points, 200, headers);
      }

      // === ポイント特典交換（女神のほほえみクーポン受け取り） ===
      if (path === "/redeem-points" && method === "POST") {
        const body = await readBody(request);
        // 旧アプリは required_points を送らない。未指定は20として扱い、明示された別値だけ拒否する。
        const requiredPoints = body.required_points == null ? 20 : Number(body.required_points);
        if (requiredPoints !== 20) return json({ error: "required_points must be 20" }, 400, headers);
        const result = await applyCouponOperation(env.DB, "redeem", body);
        return json(result.body, result.status, headers);
      }

      // === 女神のほほえみクーポン使用 ===
      if (path === "/megami-coupon/use" && method === "POST") {
        const result = await applyCouponOperation(env.DB, "use", await readBody(request));
        return json(result.body, result.status, headers);
      }

      // === 口コミ一覧（承認済み） ===
      if (path === "/reviews" && method === "GET") {
        const reviews = await env.DB.prepare(
          "SELECT id, nickname, body, owner_reply, owner_reply_at, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC LIMIT 50"
        ).all();
        return json({ reviews: reviews.results }, 200, headers);
      }

      // === 口コミ投稿 ===
      if (path === "/reviews" && method === "POST") {
        const { device_id, nickname, body } = await readBody(request);
        if (!device_id || !nickname || !body) return json({ error: "device_id, nickname, body required" }, 400, headers);
        if (nickname.length > 50) return json({ error: "nickname max 50 chars" }, 400, headers);

        const today = new Date().toISOString().slice(0, 10);
        const already = await env.DB.prepare(
          "SELECT id FROM reviews WHERE device_id = ? AND date(created_at) = ?"
        ).bind(device_id, today).first();
        if (already) return json({ error: "one review per day" }, 429, headers);

        await env.DB.prepare(
          "INSERT INTO reviews (device_id, nickname, body) VALUES (?, ?, ?)"
        ).bind(device_id, nickname, body).run();
        return json({ ok: true }, 200, headers);
      }

      // === お知らせ取得 ===
      if (path === "/notices" && method === "GET") {
        const all = url.searchParams.get("all");
        const limit = all === "1" ? 50 : 3;
        const notices = await env.DB.prepare(
          "SELECT id, body, created_at FROM notices ORDER BY created_at DESC LIMIT ?"
        ).bind(limit).all();
        return json({ notices: notices.results }, 200, headers);
      }

      // ========== 管理画面API ==========

      // === 管理認証チェック ===
      if (path.startsWith("/admin/")) {
        // Secret未設定時に「Bearer undefined」等で管理者認証が成立するのを防止。
        if (typeof env.ADMIN_PASSWORD !== "string" || !env.ADMIN_PASSWORD.trim()) {
          return json({ error: "admin not configured" }, 503, headers);
        }
        const auth = request.headers.get("Authorization");
        if (!auth || auth !== `Bearer ${env.ADMIN_PASSWORD}`) {
          return json({ error: "unauthorized" }, 401, headers);
        }
      }

      // === 口コミ一覧（管理用・全件） ===
      if (path === "/admin/reviews" && method === "GET") {
        const reviews = await env.DB.prepare(
          "SELECT * FROM reviews ORDER BY created_at DESC LIMIT 100"
        ).all();
        return json({ reviews: reviews.results }, 200, headers);
      }

      // === 口コミ承認 ===
      if (path.match(/^\/admin\/reviews\/(\d+)\/approve$/) && method === "POST") {
        const id = path.match(/^\/admin\/reviews\/(\d+)\/approve$/)[1];
        await env.DB.prepare(
          "UPDATE reviews SET approved = 1 WHERE id = ?"
        ).bind(id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 口コミ返信 ===
      if (path.match(/^\/admin\/reviews\/(\d+)\/reply$/) && method === "POST") {
        const id = path.match(/^\/admin\/reviews\/(\d+)\/reply$/)[1];
        const { reply } = await readBody(request);
        if (!reply) return json({ error: "reply required" }, 400, headers);
        await env.DB.prepare(
          "UPDATE reviews SET owner_reply = ?, owner_reply_at = datetime('now') WHERE id = ?"
        ).bind(reply, id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 口コミ削除 ===
      if (path.match(/^\/admin\/reviews\/(\d+)$/) && method === "DELETE") {
        const id = path.match(/^\/admin\/reviews\/(\d+)$/)[1];
        await env.DB.prepare(
          "DELETE FROM reviews WHERE id = ?"
        ).bind(id).run();
        return json({ ok: true }, 200, headers);
      }

      // === クーポン発行 ===
      if (path === "/admin/coupons" && method === "POST") {
        const { prize } = await readBody(request);
        if (!prize) return json({ error: "prize required" }, 400, headers);
        const code = "KNT-" + Math.random().toString(36).substring(2, 8).toUpperCase();
        await env.DB.prepare(
          "INSERT INTO coupon_codes (code, prize) VALUES (?, ?)"
        ).bind(code, prize).run();
        return json({ ok: true, code }, 200, headers);
      }

      // === クーポン一覧 ===
      if (path === "/admin/coupons" && method === "GET") {
        const coupons = await env.DB.prepare(
          "SELECT * FROM coupon_codes ORDER BY created_at DESC"
        ).all();
        return json({ coupons: coupons.results }, 200, headers);
      }

      // === お知らせ投稿 ===
      if (path === "/admin/notices" && method === "POST") {
        const { body } = await readBody(request);
        if (!body) return json({ error: "body required" }, 400, headers);
        await env.DB.prepare(
          "INSERT INTO notices (body) VALUES (?)"
        ).bind(body).run();
        return json({ ok: true }, 200, headers);
      }

      // === お知らせ削除 ===
      if (path.match(/^\/admin\/notices\/(\d+)$/) && method === "DELETE") {
        const id = path.match(/^\/admin\/notices\/(\d+)$/)[1];
        await env.DB.prepare(
          "DELETE FROM notices WHERE id = ?"
        ).bind(id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 出店場所登録 ===
      if (path === "/admin/locations" && method === "POST") {
        const { name, latitude, longitude } = await readBody(request);
        if (!name || latitude == null || longitude == null) return json({ error: "name, latitude, longitude required" }, 400, headers);
        await env.DB.prepare(
          "INSERT INTO locations (name, latitude, longitude) VALUES (?, ?, ?)"
        ).bind(name, latitude, longitude).run();
        return json({ ok: true }, 200, headers);
      }

      // === 出店場所一覧 ===
      if (path === "/admin/locations" && method === "GET") {
        const locations = await env.DB.prepare(
          "SELECT * FROM locations ORDER BY id"
        ).all();
        return json({ locations: locations.results }, 200, headers);
      }

      // === 端末情報検索（管理用） ===
      if (path === "/admin/device-info" && method === "POST") {
        const { device_id } = await readBody(request);
        if (!device_id) return json({ error: "device_id required" }, 400, headers);

        const device = await env.DB.prepare(
          "SELECT device_id, welcome_coupon_used, birth_month, birthday_coupon_used_year FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ error: "device not found" }, 404, headers);

        const points = await env.DB.prepare(
          "SELECT current_points, total_redeemed, megami_coupon_active FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();

        const checkins = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM checkin_logs WHERE device_id = ?"
        ).bind(device_id).first();

        const couponOperations = await env.DB.prepare(
          "SELECT operation, request_id, coupon_generation, created_at FROM coupon_operations_v1 WHERE device_id = ? ORDER BY id DESC LIMIT 10"
        ).bind(device_id).all();

        return json({
          device_id: device.device_id,
          welcome_coupon_used: !!device.welcome_coupon_used,
          birth_month: device.birth_month,
          birthday_coupon_used_year: device.birthday_coupon_used_year,
          current_points: points ? points.current_points : 0,
          total_redeemed: points ? points.total_redeemed : 0,
          megami_coupon_active: points ? points.megami_coupon_active : 0,
          checkin_count: checkins ? checkins.count : 0,
          coupon_operations: (couponOperations.results || []).map((row) => ({
            ...row, legacy: String(row.request_id).startsWith("legacy-")
          }))
        }, 200, headers);
      }

      // === ポイント手動付与（管理用） ===
      // 20ptは交換単位であって、保有残高の上限ではない。
      if (path === "/admin/add-points" && method === "POST") {
        const { device_id, points } = await readBody(request);
        if (typeof device_id !== "string" || !device_id.trim() || device_id.length > 128) {
          return json({ error: "invalid device_id" }, 400, headers);
        }
        // 一度の管理操作は1〜100ptに限定する。残高には20pt上限を設けない。
        if (!Number.isSafeInteger(points) || points < 1 || points > 100) {
          return json({ error: "points must be an integer from 1 to 100" }, 400, headers);
        }
        const device = await env.DB.prepare(
          "SELECT device_id FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ error: "device not found" }, 404, headers);

        const added = await env.DB.prepare(
          "INSERT INTO stamp_points (device_id, current_points, megami_coupon_active) VALUES (?, ?, 0) " +
          "ON CONFLICT(device_id) DO UPDATE SET current_points = COALESCE(stamp_points.current_points, 0) + excluded.current_points " +
          "WHERE COALESCE(stamp_points.current_points, 0) >= 0 " +
          "AND COALESCE(stamp_points.current_points, 0) <= 9007199254740991 - excluded.current_points " +
          "RETURNING current_points"
        ).bind(device_id, points).first();
        if (!added) return json({ error: "points balance would exceed safe limit" }, 409, headers);
        return json({ ok: true, current_points: added.current_points }, 200, headers);
      }

      return json({ error: "not found" }, 404, headers);

    } catch (err) {
      return json({ error: err instanceof InvalidPayload ? "invalid request body" : "internal server error" }, err instanceof InvalidPayload ? 400 : 500, headers);
    }
  }
};

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// 数値・数値文字列のみを受け付ける（"3" は旧アプリのローカル保存形式として許容）
function toSafeInt(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

function toBirthMonth(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


function getJstDate(date) {
  return new Date(date.getTime() + 32400000).toISOString().slice(0, 10);
}

// DB.batch は原子的。今回発行した attemptId と一致する受付だけ加算・記録。
async function grantCheckinPoint(db, visit) {
  const { deviceId, requestId, dayJst, scannedAt } = visit;
  const spotName = visit.spotName || "出店場所";
  const previous = await db.prepare(
    "SELECT device_id, checkin_date_jst FROM checkin_claims_v2 WHERE request_id = ?"
  ).bind(requestId).first();
  if (previous) {
    if (previous.device_id !== deviceId || previous.checkin_date_jst !== dayJst) {
      return { status: 400, body: { error: "request_id reused" } };
    }
    const points = await db.prepare(
      "SELECT current_points FROM stamp_points WHERE device_id = ?"
    ).bind(deviceId).first();
    return { status: 200, body: { ok: true, location: spotName,
      current_points: points ? points.current_points : 0 } };
  }
  if (visit.policy) {
    const age = visit.receivedAt - new Date(scannedAt).getTime();
    const { maxAgeMs, maxFutureMs } = visit.policy;
    if (age > maxAgeMs) {
      // サーバーは受付を保存しない（残すのは端末側）。受付日時と案内を返して表示できるようにする。
      return { status: 403, body: { code: "checkin_expired", retryable: false,
        scanned_at: new Date(scannedAt).toISOString(), received_at: new Date(visit.receivedAt).toISOString(),
        error: "来店受付から90日を過ぎたため、ポイントは付与されませんでした。お手数ですが店舗へご確認ください。" } };
    }
    if (age < -maxFutureMs) {
      return { status: 400, body: { code: "checkin_future", retryable: false,
        scanned_at: new Date(scannedAt).toISOString(), received_at: new Date(visit.receivedAt).toISOString(),
        error: "端末の日時をご確認ください。" } };
    }
  }
  const attemptId = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO devices (device_id) VALUES (?)").bind(deviceId),
    db.prepare(
      "INSERT INTO checkin_claims_v2 " +
      "(request_id, device_id, checkin_date_jst, attempt_id) " +
      "SELECT ?, ?, ?, ? WHERE NOT EXISTS (" +
      "SELECT 1 FROM checkin_logs WHERE device_id = ? " +
      "AND date(checked_in_at, '+9 hours') = ?" +
      ") ON CONFLICT DO NOTHING"
    ).bind(requestId, deviceId, dayJst, attemptId, deviceId, dayJst),
    db.prepare(
      "UPDATE stamp_points SET current_points = COALESCE(current_points, 0) + 1 WHERE device_id = ? " +
      "AND EXISTS (SELECT 1 FROM checkin_claims_v2 WHERE request_id = ? AND attempt_id = ?)"
    ).bind(deviceId, requestId, attemptId),
    db.prepare(
      "INSERT INTO stamp_points (device_id, current_points, megami_coupon_active) " +
      "SELECT ?, 1, 0 WHERE NOT EXISTS (" +
      "SELECT 1 FROM stamp_points WHERE device_id = ?" +
      ") AND EXISTS (" +
      "SELECT 1 FROM checkin_claims_v2 WHERE request_id = ? AND attempt_id = ?)"
    ).bind(deviceId, deviceId, requestId, attemptId),
    db.prepare(
      "INSERT INTO checkin_logs (device_id, location_id, spot_name, checked_in_at) " +
      "SELECT ?, 0, ?, datetime(?) WHERE EXISTS (" +
      "SELECT 1 FROM checkin_claims_v2 WHERE request_id = ? AND attempt_id = ?)"
    ).bind(deviceId, spotName, scannedAt, requestId, attemptId)
  ]);
  const recorded = await db.prepare(
    "SELECT device_id, checkin_date_jst FROM checkin_claims_v2 WHERE request_id = ?"
  ).bind(requestId).first();
  if (!recorded) {
    const points = await db.prepare("SELECT current_points FROM stamp_points WHERE device_id = ?").bind(deviceId).first();
    return { status: 409, body: { error: "already checked in today", current_points: points ? points.current_points : 0 } };
  }
  if (recorded.device_id !== deviceId || recorded.checkin_date_jst !== dayJst) {
    return { status: 400, body: { error: "request_id reused" } };
  }
  const points = await db.prepare(
    "SELECT current_points FROM stamp_points WHERE device_id = ?"
  ).bind(deviceId).first();
  return { status: 200, body: { ok: true, location: spotName,
    current_points: points ? points.current_points : 0 } };
}

const CHECKIN_TIME_POLICY = Object.freeze({ maxAgeMs: 90 * 86400000, maxFutureMs: 5 * 60000 });
class InvalidPayload extends Error {}
async function readBody(request) {
  try { const body = await request.json(); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); return body; }
  catch (_) { throw new InvalidPayload(); }
}

// 旧アプリ（request_id 無し）の特典操作。
// 本文は {device_id} のみで、同一操作の全リクエストがバイト単位で同一になる。
// そのため「遅延した再送」と「新しい意思」をサーバー側で区別する材料が存在しない。
// 時間窓で推測するのは誤吸収・誤消費の両方を生むだけなので採用しない。
// 方針: 状態を変えない操作だけを従来どおり返し、状態を変え得る操作は一切実行せず
//       HTTP 426 でアプリ更新を要求する（fail-closed）。ポイント・クーポンは保持される。
async function legacyCouponOperation(db, action, device) {
  const redeem = action === "redeem";
  const snapshot = await db.prepare(
    "SELECT current_points, total_redeemed, megami_coupon_active FROM stamp_points WHERE device_id = ?"
  ).bind(device).first();
  const state = {
    current_points: toSafeInt(snapshot?.current_points) ?? 0,
    total_redeemed: toSafeInt(snapshot?.total_redeemed) ?? 0,
    megami_coupon_active: toSafeInt(snapshot?.megami_coupon_active) ?? 0
  };
  // 以下3つは「どちらの解釈でも結果が同じ＝状態を変えない」ため、旧UIの文言を保ったまま返せる。
  if (redeem && state.megami_coupon_active === 1) {
    return { status: 409, body: { ok: false, legacy: true, code: "coupon_already_active",
      error: "女神のほほえみクーポンはすでに受け取り済みです。クーポンをご利用ください。", ...state } };
  }
  if (redeem && state.current_points < 20) {
    return { status: 400, body: { ok: false, legacy: true, code: "insufficient_points",
      error: "ポイントが20ポイント未満です。", ...state } };
  }
  if (!redeem && state.megami_coupon_active === 0) {
    return { status: 409, body: { ok: false, legacy: true, code: "coupon_not_active",
      error: "有効な女神のほほえみクーポンがありません。", ...state } };
  }
  // ここに来る要求は状態を変え得る＝再送か新規意思かを識別できない。実行しない。
  return { status: 426, body: { ok: false, legacy: true, retryable: false, code: "app_update_required",
    error: "このアプリでは特典の受け取り・利用を実行できません。アプリを最新版に更新してください。ポイントとクーポンはそのまま残っています。",
    ...state } };
}

// 台帳挿入・残高更新・応答用の読み取りを1つのD1トランザクション（batch）で行う。
// 旧アプリ経路は legacyCouponOperation（fail-closed）が担当し、ここには到達しない。
async function applyCouponOperation(db, action, body) {
  const { device_id: device } = body;
  if (typeof device !== "string" || !device.trim() || device.length > 128) {
    return { status: 400, body: { code: "invalid_device_id", error: "device_id が不正です。" } };
  }
  const redeem = action === "redeem";
  const rawRequestId = body.request_id;
  const hasRequestId = typeof rawRequestId === "string" && rawRequestId.length > 0;

  if (!hasRequestId) return legacyCouponOperation(db, action, device);

  const generation = toSafeInt(body.coupon_generation);
  if (!REQUEST_ID_RE.test(rawRequestId) || generation === null || generation < 0) {
    return { status: 400, body: { code: "coupon_operation_id_required", error: "アプリを更新してから特典を操作してください。" } };
  }
  const requestId = rawRequestId;
  const eligibility = redeem
    ? "current_points >= 20 AND COALESCE(megami_coupon_active, 0) = 0"
    : "megami_coupon_active = 1";
  const update = redeem
    ? "current_points = current_points - 20, total_redeemed = COALESCE(total_redeemed, 0) + 1, megami_coupon_active = 1"
    : "megami_coupon_active = 0";
  const attempt = crypto.randomUUID();
  const [, , recorded, state] = await db.batch([
    db.prepare(
      "INSERT INTO coupon_operations_v1 (device_id, operation, request_id, coupon_generation, attempt_id) " +
      "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM stamp_points WHERE device_id = ? " +
      "AND COALESCE(total_redeemed, 0) = ? AND " + eligibility + ") ON CONFLICT DO NOTHING"
    ).bind(device, action, requestId, generation, attempt, device, generation),
    db.prepare(
      "UPDATE stamp_points SET " + update + " WHERE device_id = ? AND EXISTS (" +
      "SELECT 1 FROM coupon_operations_v1 WHERE device_id = ? AND operation = ? AND request_id = ? AND attempt_id = ?)"
    ).bind(device, device, action, requestId, attempt),
    db.prepare("SELECT coupon_generation, attempt_id FROM coupon_operations_v1 WHERE device_id = ? AND operation = ? AND request_id = ?")
      .bind(device, action, requestId),
    db.prepare("SELECT current_points, total_redeemed, megami_coupon_active FROM stamp_points WHERE device_id = ?")
      .bind(device)
  ]);
  const operation = recorded.results[0];
  if (!operation || toSafeInt(operation.coupon_generation) !== generation) {
    // 台帳にこの世代の行が無い＝世代が進んでいる／条件を満たさない／同じrequest_idを別世代で再利用した。
    // いずれも状態は変更していない。
    return { status: 409, body: { code: "coupon_state_conflict", error: "特典の状態が変わりました。残高を更新してご確認ください。" } };
  }
  const current = state.results[0];
  return { status: 200, body: { ok: true, replayed: operation.attempt_id !== attempt,
    current_points: current?.current_points ?? 0, total_redeemed: current?.total_redeemed ?? 0,
    megami_coupon_active: current?.megami_coupon_active ?? 0 } };
}