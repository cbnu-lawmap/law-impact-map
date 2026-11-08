/*
 * 법안 영향 지도 — 브이월드 WebGL 3D 지도 (버전 3.0)
 *
 * 브이월드 3D 건물 모델 위에 사창동 건물 바닥면을 판정·노후도 색으로 덧칠한다.
 * 브이월드 3.0은 Cesium 기반이라 ws3d.viewer(Cesium Viewer)와 Cesium 문법을 그대로 쓴다.
 * API 키가 없거나 지도를 띄우지 못하면 app.js 가 기본 3D 지도(MapLibre)로 돌아간다.
 */
(function (global) {
  "use strict";

  var READY_TIMEOUT_MS = 20000;
  var FILL_ALPHA = 0.7;

  function toColor(c, a) {
    var r, g, b;
    if (c.charAt(0) === "#") {
      var n = parseInt(c.slice(1), 16);
      r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
    } else {
      var m = c.match(/\d+/g);
      r = +m[0]; g = +m[1]; b = +m[2];
    }
    return new Cesium.Color(r / 255, g / 255, b / 255, a);
  }

  function polygonsOf(geom) {
    if (geom.type === "Polygon") return [geom.coordinates];
    if (geom.type === "MultiPolygon") return geom.coordinates;
    return [];
  }

  function flat(ring) {
    var out = [];
    ring.forEach(function (c) { out.push(c[0], c[1]); });
    return out;
  }

  function inRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function inPolygon(x, y, poly) {
    if (!inRing(x, y, poly[0])) return false;
    for (var h = 1; h < poly.length; h++) if (inRing(x, y, poly[h])) return false;
    return true;
  }

  function bboxOf(c, b) {
    b = b || [Infinity, Infinity, -Infinity, -Infinity];
    if (typeof c[0] === "number") {
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
      b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
    } else c.forEach(function (x) { bboxOf(x, b); });
    return b;
  }

  /**
   * opts.mapId   지도 div 아이디
   * opts.onPick  function(index | null, {x, y}) 건물 클릭 시
   * 반환: { ready: Promise, add(buildings, boundary), recolor(colorOf) }
   */
  function create(opts) {
    var viewer = null;
    var items = [];   // {i, entity, polys, bbox}
    var classify = false;

    var ready = new Promise(function (resolve, reject) {
      if (!global.vw || !global.vw.Map) { reject(new Error("브이월드 API를 불러오지 못함")); return; }
      var map = new vw.Map();
      map.setOption({
        mapId: opts.mapId,
        initPosition: new vw.CameraPosition(new vw.CoordZ(127.462, 36.621, 900), new vw.Direction(0, -38, 0)),
        logo: true,
        navigation: true,
      });
      map.start();
      var t0 = Date.now();
      (function wait() {
        if (global.ws3d && ws3d.viewer && global.Cesium) {
          viewer = ws3d.viewer;
          classify = !!(Cesium.ClassificationType && Cesium.ClassificationType.BOTH !== undefined);
          resolve();
        } else if (Date.now() - t0 > READY_TIMEOUT_MS) {
          reject(new Error("브이월드 3D 지도 시작 시간 초과"));
        } else setTimeout(wait, 200);
      })();
    });

    function add(buildings, boundary, colorOf, heightOf) {
      buildings.features.forEach(function (f) {
        var i = f.properties._i;
        var polys = polygonsOf(f.geometry);
        polys.forEach(function (poly) {
          var hierarchy = new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(flat(poly[0])),
            poly.slice(1).map(function (h) { return new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat(h))); })
          );
          var pg = { hierarchy: hierarchy, material: toColor(colorOf(i), FILL_ALPHA) };
          if (classify) {
            // 바닥면 색을 브이월드 3D 건물 모델과 지형에 입힌다
            pg.classificationType = Cesium.ClassificationType.BOTH;
          } else {
            // 덧칠을 지원하지 않는 버전이면 층수 높이로 세운다
            pg.height = 0;
            pg.extrudedHeight = heightOf(i);
          }
          var e = viewer.entities.add({ polygon: pg });
          e._bldg = i;
          items.push({ i: i, entity: e, polys: [poly], bbox: bboxOf(poly) });
        });
      });

      var bb = null;
      boundary.features.forEach(function (f) {
        bb = bboxOf(f.geometry.coordinates, bb);
        polygonsOf(f.geometry).forEach(function (poly) {
          viewer.entities.add({
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(flat(poly[0])),
              width: 3,
              clampToGround: true,
              material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString("#1f4fa3") }),
            },
          });
        });
      });

      // 동 경계 남쪽에서 북쪽을 비스듬히 내려다보기
      if (bb) {
        var cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
        var pitch = -38, h = 900;
        var back = h / Math.tan((-pitch * Math.PI) / 180) / 111000;
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(cx, cy - back, h),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitch), roll: 0 },
        });
      }

      var handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction(function (ev) {
        opts.onPick(pick(ev.position), { x: ev.position.x, y: ev.position.y });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    // 클릭 위치의 건물 번호.
    // 덧칠 영역은 위아래로 길게 서 있어 비스듬히 보면 앞 건물 영역이 뒤 건물을 가린다.
    // 그래서 클릭한 3D 모델 지점(지붕 등)의 경위도가 들어가는 바닥면을 우선 고른다.
    function pick(pos) {
      var scene = viewer.scene;
      var cands = [];
      try {
        scene.drillPick(pos, 6).forEach(function (h) {
          if (h && h.id && h.id._bldg !== undefined && cands.indexOf(h.id._bldg) < 0) cands.push(h.id._bldg);
        });
      } catch (e) { cands = []; }

      var cart = null;
      try { if (scene.pickPositionSupported) cart = scene.pickPosition(pos); } catch (e) { cart = null; }
      if (!cart) cart = scene.globe.pick(viewer.camera.getPickRay(pos), scene);
      if (cart) {
        var c = Cesium.Cartographic.fromCartesian(cart);
        var x = Cesium.Math.toDegrees(c.longitude), y = Cesium.Math.toDegrees(c.latitude);
        var pool = cands.length ? items.filter(function (it) { return cands.indexOf(it.i) >= 0; }) : items;
        for (var k = 0; k < pool.length; k++) {
          var it = pool[k], b = it.bbox;
          if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
          if (inPolygon(x, y, it.polys[0])) return it.i;
        }
      }
      return cands.length ? cands[0] : null;
    }

    function recolor(colorOf) {
      items.forEach(function (it) {
        it.entity.polygon.material = toColor(colorOf(it.i), FILL_ALPHA);
      });
    }

    return { ready: ready, add: add, recolor: recolor, classify: function () { return classify; } };
  }

  global.VWorldMap = { create: create };
})(this);
