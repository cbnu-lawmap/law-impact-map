/*
 * 빼곡 — 브이월드 WebGL 3D 지도 (버전 3.0)
 *
 * 브이월드 3D 건물 모델 위에 사창동 건물 바닥면을 판정·노후도 색으로 덧칠한다.
 * 브이월드 3.0은 Cesium 기반이라 ws3d.viewer(Cesium Viewer)와 Cesium 문법을 그대로 쓴다.
 * API 키가 없거나 지도를 띄우지 못하면 app.js 가 기본 3D 지도(MapLibre)로 돌아간다.
 */
(function (global) {
  "use strict";

  var READY_TIMEOUT_MS = 20000;
  var FILL_ALPHA = 0.7;   // 실제 건물 모델 위 덧칠
  var BOX_ALPHA = 0.8;    // 상자 건물

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
   * 건물 바닥면 덧칠 레이어.
   * 건물마다 엔티티를 만들면 2천여 개가 따로 그려져 느리므로, GeometryInstance 를 한 Primitive 로 묶고
   * 색은 인스턴스 속성만 바꾼다 (다시 만들지 않음).
   */
  function BuildingLayer(viewer, buildings, colorOf, heightOf, classify) {
    var items = [];       // {i, id, poly, bbox}
    var instances = [];
    // 덧칠은 평면색, 상자 건물은 빛을 받아 면이 구분되게(입체감) 그린다
    var appearance = new Cesium.PerInstanceColorAppearance({ flat: classify, translucent: true });
    var alpha = classify ? FILL_ALPHA : BOX_ALPHA;
    buildings.features.forEach(function (f) {
      var i = f.properties._i;
      polygonsOf(f.geometry).forEach(function (poly, k) {
        var hierarchy = new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray(flat(poly[0])),
          poly.slice(1).map(function (h) { return new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat(h))); })
        );
        var geomOpts = { polygonHierarchy: hierarchy, vertexFormat: appearance.vertexFormat };
        if (!classify) { geomOpts.height = 0; geomOpts.extrudedHeight = heightOf(i); }
        var id = { bldg: i, key: i + ":" + k };   // 색을 바꿀 때 같은 객체로 찾는다
        instances.push(new Cesium.GeometryInstance({
          id: id,
          geometry: new Cesium.PolygonGeometry(geomOpts),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(toColor(colorOf(i), alpha)) },
        }));
        items.push({ i: i, id: id, poly: poly, bbox: bboxOf(poly) });
      });
    });

    var prim = classify
      // 바닥면 색을 브이월드 3D 건물 모델과 지형에 입힌다
      ? new Cesium.GroundPrimitive({
          geometryInstances: instances, appearance: appearance,
          classificationType: Cesium.ClassificationType.BOTH, releaseGeometryInstances: false,
        })
      // 상자 건물: 층수 높이로 세운다 (기본 방식, 또는 덧칠을 지원하지 않는 버전)
      : new Cesium.Primitive({ geometryInstances: instances, appearance: appearance, releaseGeometryInstances: false });
    viewer.scene.primitives.add(prim);

    this.items = items;
    this.recolor = function (colorOf2) {
      var apply = function () {
        items.forEach(function (it) {
          var a = prim.getGeometryInstanceAttributes(it.id);
          if (a) a.color = Cesium.ColorGeometryInstanceAttribute.toValue(toColor(colorOf2(it.i), alpha), a.color);
        });
        viewer.scene.requestRender();
      };
      if (prim.ready) apply(); else prim.readyPromise ? prim.readyPromise.then(apply) : setTimeout(apply, 500);
    };
    this.destroy = function () { viewer.scene.primitives.remove(prim); };
  }

  /**
   * opts.mapId   지도 div 아이디
   * opts.onPick  function(index | null, {x, y}) 건물 클릭 시
   * opts.onMove  function() 지도를 움직이기 시작할 때
   * opts.realModels  true 면 브이월드 실제 3D 건물 모델 위에 색을 덧칠 (무거움).
   *                  기본(false)은 실제 건물·지형을 끄고 항공사진 위에 층수 높이 상자 건물만 세운다 (가벼움).
   * 반환: { ready: Promise, add(buildings, boundary, colorOf, heightOf), recolor(colorOf) }
   */
  function create(opts) {
    var viewer = null;
    var layer = null;
    var classify = false;
    var userMoved = false;

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
          // 가만히 있을 때는 다시 그리지 않는다 (조작·타일 로딩·색 변경 때만 그림) → CPU/GPU 부담 감소
          viewer.scene.requestRenderMode = true;
          viewer.scene.maximumRenderTimeChange = Infinity;
          // 요청 렌더 모드에서는 위성영상·3D 타일이 다 받아져도 다시 그리지 않아 화면이 빈 채로 남는다.
          // 타일 로딩 상태가 바뀔 때마다 한 번씩 다시 그리게 한다.
          viewer.scene.globe.tileLoadProgressEvent.addEventListener(function () { viewer.scene.requestRender(); });
          var warmEnd = Date.now() + 30000;
          var warm = setInterval(function () {
            if (Date.now() > warmEnd) { clearInterval(warm); return; }
            viewer.scene.requestRender();
          }, 500);
          // 휴대폰·태블릿: 화질을 조금 낮춰 부담을 줄인다 (가장자리 다듬기·안개 끄기, 지형 타일 덜 세밀하게)
          if (global.matchMedia && matchMedia("(pointer: coarse)").matches) {
            if (viewer.scene.postProcessStages.fxaa) viewer.scene.postProcessStages.fxaa.enabled = false;
            viewer.scene.fog.enabled = false;
            viewer.scene.globe.maximumScreenSpaceError = 3;
          }
          // 지도를 움직이기 시작하면 건물 카드를 닫는다 (카드가 엉뚱한 곳에 남지 않게)
          viewer.camera.moveStart.addEventListener(function () { if (opts.onMove) opts.onMove(); });
          classify = !!(opts.realModels && Cesium.ClassificationType &&
            Cesium.ClassificationType.BOTH !== undefined && Cesium.GroundPrimitive);
          if (!opts.realModels) {
            // 실제 건물 모델은 계속 새 조각을 받아 그려야 해서 무겁다 → 끄고, 지형도 평평하게(높이 0) 둔다.
            // 브이월드가 나중에 모델·지형을 다시 넣을 수 있어 한동안, 그리고 카메라 이동이 끝날 때마다 다시 끈다.
            lightMode();
            var lightEnd = Date.now() + 60000;
            var light = setInterval(function () {
              if (Date.now() > lightEnd) { clearInterval(light); return; }
              lightMode();
            }, 500);
            viewer.camera.moveEnd.addEventListener(lightMode);
            // 항공사진 색을 눌러(채도 낮춤) 색칠한 건물이 먼저 눈에 들어오게 한다.
            // 브이월드가 나중에 영상 레이어를 더 넣을 수 있어, 레이어가 들어올 때마다 다시 맞춘다.
            softenImagery();
            viewer.imageryLayers.layerAdded.addEventListener(function (l) { softenLayer(l); viewer.scene.requestRender(); });
          }
          resolve();
        } else if (Date.now() - t0 > READY_TIMEOUT_MS) {
          reject(new Error("브이월드 3D 지도 시작 시간 초과"));
        } else setTimeout(wait, 200);
      })();
    });

    function hideModels(col) {
      var changed = false;
      for (var i = 0; i < col.length; i++) {
        var p = col.get(i);
        if (p instanceof Cesium.Cesium3DTileset) { if (p.show) { p.show = false; changed = true; } }
        else if (p instanceof Cesium.PrimitiveCollection && hideModels(p)) changed = true;
      }
      return changed;
    }

    var IMAGERY_TONE = { saturation: 0.4, brightness: 0.95, contrast: 1.0 };
    function softenLayer(l) {
      if (!l) return;
      l.saturation = IMAGERY_TONE.saturation;
      l.brightness = IMAGERY_TONE.brightness;
      l.contrast = IMAGERY_TONE.contrast;
    }
    function softenImagery() {
      var L = viewer.imageryLayers;
      for (var i = 0; i < L.length; i++) softenLayer(L.get(i));
      viewer.scene.requestRender();
    }

    function lightMode() {
      var changed = hideModels(viewer.scene.primitives);
      // 브이월드가 영상 레이어를 늦게 넣어 layerAdded 를 놓칠 수 있으므로 여기서도 톤을 맞춘다
      var L = viewer.imageryLayers;
      for (var i = 0; i < L.length; i++) {
        if (L.get(i).saturation !== IMAGERY_TONE.saturation) { softenLayer(L.get(i)); changed = true; }
      }
      if (!(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)) {
        viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        changed = true;
      }
      if (changed) viewer.scene.requestRender();
    }

    function add(buildings, boundary, colorOf, heightOf) {
      layer = new BuildingLayer(viewer, buildings, colorOf, heightOf, classify);

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

      // 동 경계 남쪽에서 북쪽을 비스듬히 내려다보기.
      // 브이월드가 시작하고 몇 초 뒤(기기마다 다름) 카메라를 제멋대로 옮기므로,
      // 사용자가 조작하기 전까지는 시점이 벗어나면 다시 맞춘다.
      if (bb) {
        var cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
        var pitch = -38, h = 900;
        var back = h / Math.tan((-pitch * Math.PI) / 180) / 111000;
        var home = function () {
          viewer.camera.cancelFlight();
          viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(cx, cy - back, h),
            orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitch), roll: 0 },
          });
          viewer.scene.requestRender();
        };
        var offHome = function () {
          var c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
          return Math.abs(Cesium.Math.toDegrees(c.latitude) - (cy - back)) > 0.0005 ||
            Math.abs(Cesium.Math.toDegrees(c.longitude) - cx) > 0.0005 || Math.abs(c.height - h) > 30;
        };
        home();
        // 느린 기기·네트워크에서는 20초 넘어서도 옮기므로, 사용자가 조작하기 전까지는 계속 되돌린다.
        var guardEnd = Date.now() + 60000;
        var guard = setInterval(function () {
          if (userMoved || Date.now() > guardEnd) { clearInterval(guard); return; }
          if (offHome()) home();
        }, 300);
        viewer.camera.moveEnd.addEventListener(function () {
          if (!userMoved && offHome()) home();
        });
      }

      var handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      var moved = function () { userMoved = true; };
      [Cesium.ScreenSpaceEventType.LEFT_DOWN, Cesium.ScreenSpaceEventType.RIGHT_DOWN,
        Cesium.ScreenSpaceEventType.MIDDLE_DOWN, Cesium.ScreenSpaceEventType.WHEEL,
        Cesium.ScreenSpaceEventType.PINCH_START].forEach(function (t) { handler.setInputAction(moved, t); });
      handler.setInputAction(function (ev) {
        opts.onPick(pick(ev.position), { x: ev.position.x, y: ev.position.y });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    // 클릭 위치의 건물 번호.
    // 덧칠 영역은 위아래로 길게 서 있어 비스듬히 보면 앞 건물 영역이 뒤 건물을 가린다.
    // 그래서 클릭한 3D 모델 지점(지붕 등)의 경위도가 들어가는 바닥면을 우선 고른다.
    function pick(pos) {
      if (!layer) return null;
      var scene = viewer.scene;
      var cands = [];
      try {
        scene.drillPick(pos, 6).forEach(function (h) {
          if (h && h.id && h.id.bldg !== undefined && cands.indexOf(h.id.bldg) < 0) cands.push(h.id.bldg);
        });
      } catch (e) { cands = []; }

      var cart = null;
      try { if (scene.pickPositionSupported) cart = scene.pickPosition(pos); } catch (e) { cart = null; }
      if (!cart) cart = scene.globe.pick(viewer.camera.getPickRay(pos), scene);
      if (cart) {
        var c = Cesium.Cartographic.fromCartesian(cart);
        var x = Cesium.Math.toDegrees(c.longitude), y = Cesium.Math.toDegrees(c.latitude);
        var pool = cands.length ? layer.items.filter(function (it) { return cands.indexOf(it.i) >= 0; }) : layer.items;
        for (var k = 0; k < pool.length; k++) {
          var it = pool[k], b = it.bbox;
          if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
          if (inPolygon(x, y, it.poly)) return it.i;
        }
      }
      return cands.length ? cands[0] : null;
    }

    function recolor(colorOf) { if (layer) layer.recolor(colorOf); }

    return { ready: ready, add: add, recolor: recolor, classify: function () { return classify; } };
  }

  global.VWorldMap = { create: create, BuildingLayer: BuildingLayer };
})(this);
