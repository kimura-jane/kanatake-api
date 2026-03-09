export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

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
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO devices (device_id) VALUES (?)"
        ).bind(device_id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 初回クーポン使用 ===
      if (path === "/welcome-coupon" && method === "POST") {
        const { device_id, choice } = await request.json();
        if (!device_id || !choice) return json({ error: "device_id and choice required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT welcome_coupon_used FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ error: "device not found" }, 404, headers);
        if (device.welcome_coupon_used) return json({ error: "already used" }, 409, headers);
        await env.DB.prepare(
          "UPDATE devices SET welcome_coupon_used = 1 WHERE device_id = ?"
        ).bind(device_id).run();
        return json({ ok: true, choice }, 200, headers);
      }

      // === 初回クーポン状態確認 ===
      if (path === "/welcome-coupon/status" && method === "POST") {
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT welcome_coupon_used FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ used: false }, 200, headers);
        return json({ used: !!device.welcome_coupon_used }, 200, headers);
      }

      // === FiNANCiEクーポンコード入力 ===
      if (path === "/redeem-code" && method === "POST") {
        const { device_id, code } = await request.json();
        if (!device_id || !code) return json({ error: "device_id and code required" }, 400, headers);
        const coupon = await env.DB.prepare(
          "SELECT * FROM coupon_codes WHERE code = ?"
        ).bind(code).first();
        if (!coupon) return json({ error: "invalid code" }, 404, headers);
        if (coupon.used) return json({ error: "already used" }, 409, headers);
        await env.DB.prepare(
          "UPDATE coupon_codes SET used = 1, used_by_device = ?, used_at = datetime('now') WHERE code = ?"
        ).bind(device_id, code).run();
        return json({ ok: true, prize: coupon.prize }, 200, headers);
      }

      // === チェックイン（来店ポイント） ===
      if (path === "/checkin" && method === "POST") {
        const { device_id, latitude, longitude } = await request.json();
        if (!device_id || latitude == null || longitude == null) {
          return json({ error: "device_id, latitude, longitude required" }, 400, headers);
        }

        const today = new Date().toISOString().slice(0, 10);
        const already = await env.DB.prepare(
          "SELECT id FROM checkin_logs WHERE device_id = ? AND date(checked_in_at) = ?"
        ).bind(device_id, today).first();
        if (already) return json({ error: "already checked in today" }, 409, headers);

        const locations = await env.DB.prepare(
          "SELECT * FROM locations"
        ).all();

        let nearestLocation = null;
        let minDist = Infinity;
        for (const loc of locations.results) {
          const dist = getDistance(latitude, longitude, loc.latitude, loc.longitude);
          if (dist < minDist) {
            minDist = dist;
            nearestLocation = loc;
          }
        }

        if (!nearestLocation || minDist > 500) {
          return json({ error: "not within 500m of any location", distance: Math.round(minDist) }, 403, headers);
        }

        await env.DB.prepare(
          "INSERT INTO checkin_logs (device_id, location_id) VALUES (?, ?)"
        ).bind(device_id, nearestLocation.id).run();

        const points = await env.DB.prepare(
          "SELECT current_points FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();

        if (points) {
          await env.DB.prepare(
            "UPDATE stamp_points SET current_points = current_points + 1 WHERE device_id = ?"
          ).bind(device_id).run();
        } else {
          await env.DB.prepare(
            "INSERT INTO stamp_points (device_id, current_points) VALUES (?, 1)"
          ).bind(device_id).run();
        }

        const updated = await env.DB.prepare(
          "SELECT current_points FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();

        return json({
          ok: true,
          location: nearestLocation.name,
          current_points: updated.current_points
        }, 200, headers);
      }

      // === ポイント取得 ===
      if (path === "/points" && method === "POST") {
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const points = await env.DB.prepare(
          "SELECT current_points, total_redeemed FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();
        if (!points) return json({ current_points: 0, total_redeemed: 0 }, 200, headers);
        return json(points, 200, headers);
      }

      // === ポイント特典交換 ===
      if (path === "/redeem-points" && method === "POST") {
        const { device_id, required_points } = await request.json();
        if (!device_id || !required_points) return json({ error: "device_id and required_points required" }, 400, headers);
        const points = await env.DB.prepare(
          "SELECT current_points FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();
        if (!points || points.current_points < required_points) {
          return json({ error: "not enough points" }, 400, headers);
        }
        await env.DB.prepare(
          "UPDATE stamp_points SET current_points = 0, total_redeemed = total_redeemed + 1 WHERE device_id = ?"
        ).bind(device_id).run();
        return json({ ok: true }, 200, headers);
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
        const { device_id, nickname, body } = await request.json();
        if (!device_id || !nickname || !body) return json({ error: "device_id, nickname, body required" }, 400, headers);
        if (nickname.length > 50) return json({ error: "nickname max 50 chars" }, 400, headers);
        if (body.length > 600) return json({ error: "body max 600 chars" }, 400, headers);

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
        const notices = await env.DB.prepare(
          "SELECT id, body, created_at FROM notices ORDER BY created_at DESC LIMIT 3"
        ).all();
        return json({ notices: notices.results }, 200, headers);
      }

      // ========== 管理画面API ==========

      // === 管理認証チェック ===
      if (path.startsWith("/admin/")) {
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
        const { reply } = await request.json();
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
        const { prize } = await request.json();
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
        const { body } = await request.json();
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
        const { name, latitude, longitude } = await request.json();
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

      return json({ error: "not found" }, 404, headers);

    } catch (err) {
      return json({ error: err.message }, 500, headers);
    }
  }
};

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
