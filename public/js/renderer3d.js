/**
 * renderer3d.js — Real-time Three.js WebGL 3D Engine & Articulated 3D Models
 * for 'KANLI AY' (2400x1800 World mapped to X=wx, Y=height, Z=wy).
 */

(() => {
  "use strict";

  const THREE = window.THREE;

  class GothicRenderer3D {
    constructor(canvasEl) {
      this.canvas = canvasEl;
      this.cameraMode = "angled"; // "angled" | "overhead"
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x05060a);
      this.scene.fog = new THREE.FogExp2(0x05060b, 0.00052);

      this.camera = new THREE.PerspectiveCamera(
        48,
        Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
        10,
        3600
      );

      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        powerPreference: "high-performance",
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      this.raycaster = new THREE.Raycaster();
      this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this.tmpVec = new THREE.Vector3();
      this.tmpNdc = new THREE.Vector2();
      this.tmpGroundHit = new THREE.Vector3();

      this.worldGroup = new THREE.Group();
      this.scene.add(this.worldGroup);

      this.groundMesh = null;
      this.groundMat = null;
      this.fogMesh = null;
      this.moonLight = null;

      this.fogCanvas = document.createElement("canvas");
      this.fogCanvas.width = 600;
      this.fogCanvas.height = 450;
      this.fogCtx = this.fogCanvas.getContext("2d");
      this.fogTex = new THREE.CanvasTexture(this.fogCanvas);
      this.fogTex.minFilter = THREE.LinearFilter;
      this.fogTex.magFilter = THREE.LinearFilter;

      this.treeMeshes = [];
      this.totemNodes = [];
      this.cageNodes = [];
      this.palletNodes = [];
      this.gateNodes = [];
      this.playerNodes = new Map();
      this.fxGroup = new THREE.Group();

      this._setupLights();
      this._loadGroundTexture("/assets/sprites/ground_tile.png");
    }

    _setupLights() {
      const ambient = new THREE.AmbientLight(0x3a4a6a, 0.95);
      this.scene.add(ambient);

      const hemi = new THREE.HemisphereLight(0x5b729c, 0x141720, 0.6);
      this.scene.add(hemi);

      const moon = new THREE.DirectionalLight(0x9bb8eb, 0.85);
      moon.position.set(1200, 950, 900);
      moon.castShadow = true;
      moon.shadow.mapSize.width = 1024;
      moon.shadow.mapSize.height = 1024;
      moon.shadow.camera.near = 100;
      moon.shadow.camera.far = 2200;
      const d = 950;
      moon.shadow.camera.left = -d;
      moon.shadow.camera.right = d;
      moon.shadow.camera.top = d;
      moon.shadow.camera.bottom = -d;
      moon.shadow.bias = -0.001;
      this.scene.add(moon);
      this.scene.add(moon.target);
      this.moonLight = moon;
    }

    _loadGroundTexture(src) {
      const loader = new THREE.TextureLoader();
      loader.load(src, (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(10, 7.5);
        tex.anisotropy = 4;
        if (this.groundMat) {
          this.groundMat.map = tex;
          this.groundMat.color.setHex(0xb8c0cc);
          this.groundMat.needsUpdate = true;
        }
        this._cachedGroundTex = tex;
      });
    }

    updateGroundTexture(src) {
      this._loadGroundTexture(src);
    }

    resize(w, h) {
      this.camera.aspect = Math.max(1, w) / Math.max(1, h);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
    }

    toggleCameraMode() {
      this.cameraMode = this.cameraMode === "angled" ? "overhead" : "angled";
      return this.cameraMode;
    }

    _disposeGroup(group) {
      while (group.children.length > 0) {
        group.remove(group.children[0]);
      }
    }

    buildWorld(world) {
      this._disposeGroup(this.worldGroup);
      this.treeMeshes = [];
      this.totemNodes = [];
      this.cageNodes = [];
      this.palletNodes = [];
      this.gateNodes = [];
      this.playerNodes.clear();

      // 1. 3D Ground Plane (2400 x 1800)
      const groundGeo = new THREE.PlaneGeometry(2400, 1800);
      this.groundMat = new THREE.MeshStandardMaterial({
        color: this._cachedGroundTex ? 0xb8c0cc : 0x1a1e26,
        map: this._cachedGroundTex || null,
        roughness: 0.94,
        metalness: 0.05,
      });
      this.groundMesh = new THREE.Mesh(groundGeo, this.groundMat);
      this.groundMesh.rotation.x = -Math.PI / 2;
      this.groundMesh.position.set(1200, 0, 900);
      this.groundMesh.receiveShadow = true;
      this.worldGroup.add(this.groundMesh);

      // 3D World-Space Ground Fog of War (sits at Y=2.4 so 3D walls & trees stay cleanly above it)
      const fogGeo = new THREE.PlaneGeometry(2400, 1800);
      const fogMat = new THREE.MeshBasicMaterial({
        map: this.fogTex,
        transparent: true,
        depthTest: true,
        depthWrite: false,
      });
      this.fogMesh = new THREE.Mesh(fogGeo, fogMat);
      this.fogMesh.rotation.x = -Math.PI / 2;
      this.fogMesh.position.set(1200, 2.4, 900);
      this.fogMesh.renderOrder = 2;
      this.worldGroup.add(this.fogMesh);

      // Subtle cobble road inlays
      const roadMat = new THREE.MeshStandardMaterial({
        color: 0x26252b,
        roughness: 0.9,
        transparent: true,
        opacity: 0.35,
      });
      const nsRoad = new THREE.Mesh(new THREE.PlaneGeometry(66, 1700), roadMat);
      nsRoad.rotation.x = -Math.PI / 2;
      nsRoad.position.set(1200, 0.3, 900);
      this.worldGroup.add(nsRoad);

      // 2. 3D Stone & Cabin Walls
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x2c3240, roughness: 0.85, metalness: 0.1 });
      const stoneCapMat = new THREE.MeshStandardMaterial({ color: 0x454f63, roughness: 0.7 });
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1f, roughness: 0.88 });
      const woodCapMat = new THREE.MeshStandardMaterial({ color: 0x5c4230, roughness: 0.75 });

      for (const w of world.walls) {
        const h = w.kind === "stone" ? 66 : 56;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(w.w, h, w.h),
          w.kind === "stone" ? stoneMat : woodMat
        );
        mesh.position.set(w.x + w.w / 2, h / 2, w.y + w.h / 2);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.worldGroup.add(mesh);

        const cap = new THREE.Mesh(
          new THREE.BoxGeometry(w.w + 3, 5, w.h + 3),
          w.kind === "stone" ? stoneCapMat : woodCapMat
        );
        cap.position.set(w.x + w.w / 2, h + 1.5, w.y + w.h / 2);
        this.worldGroup.add(cap);
      }

      // 3. 3D Gothic Pine Trees
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x362419, roughness: 0.95 });
      const leafMats = [
        new THREE.MeshStandardMaterial({ color: 0x13291d, roughness: 0.88 }),
        new THREE.MeshStandardMaterial({ color: 0x193826, roughness: 0.86 }),
        new THREE.MeshStandardMaterial({ color: 0x224a33, roughness: 0.84 }),
      ];

      world.trees.forEach((tr, idx) => {
        const g = new THREE.Group();
        g.position.set(tr.x, 0, tr.y);
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(tr.r * 0.22, tr.r * 0.34, 42, 8),
          trunkMat
        );
        trunk.position.y = 21;
        trunk.castShadow = true;
        g.add(trunk);

        const crown = new THREE.Group();
        for (let tier = 0; tier < 3; tier++) {
          const coneR = tr.r * (0.98 - tier * 0.22);
          const coneH = 44 - tier * 6;
          const cone = new THREE.Mesh(new THREE.ConeGeometry(coneR, coneH, 8), leafMats[tier]);
          cone.position.y = 46 + tier * 24;
          cone.castShadow = true;
          crown.add(cone);
        }
        g.add(crown);
        this.worldGroup.add(g);
        this.treeMeshes.push({ group: crown, phase: idx * 0.7 });
      });

      // 4. 3D Lockers (Saklanma Dolapları)
      const lockerMat = new THREE.MeshStandardMaterial({ color: 0x422b1d, roughness: 0.8 });
      const ironMat = new THREE.MeshStandardMaterial({ color: 0x525866, roughness: 0.5, metalness: 0.65 });
      for (const loc of world.lockers) {
        const lg = new THREE.Group();
        lg.position.set(loc.x, 0, loc.y);
        const body = new THREE.Mesh(new THREE.BoxGeometry(34, 64, 34), lockerMat);
        body.position.y = 32;
        body.castShadow = true;
        body.receiveShadow = true;
        lg.add(body);

        const trim = new THREE.Mesh(new THREE.BoxGeometry(36, 6, 36), ironMat);
        trim.position.y = 63;
        lg.add(trim);

        const handle = new THREE.Mesh(new THREE.BoxGeometry(4, 10, 4), ironMat);
        handle.position.set(8, 34, 18);
        lg.add(handle);
        this.worldGroup.add(lg);
      }

      // 5. 3D Pallets (Devrilebilir Ahşap Barikatlar)
      const palletWoodMat = new THREE.MeshStandardMaterial({ color: 0x85522b, roughness: 0.82 });
      const palletTrimMat = new THREE.MeshStandardMaterial({ color: 0xc28a46, roughness: 0.6 });
      for (const pal of world.pallets) {
        const root = new THREE.Group();
        root.position.set(pal.x, 0, pal.y);
        if (pal.dir === "v") root.rotation.y = Math.PI / 2;

        const pivot = new THREE.Group();
        pivot.position.set(0, 4, -12);
        const plank = new THREE.Mesh(new THREE.BoxGeometry(74, 8, 24), palletWoodMat);
        plank.position.set(0, 0, 12);
        plank.castShadow = true;
        pivot.add(plank);

        for (let sx = -26; sx <= 26; sx += 26) {
          const slat = new THREE.Mesh(new THREE.BoxGeometry(6, 10, 26), palletTrimMat);
          slat.position.set(sx, 0.5, 12);
          pivot.add(slat);
        }
        root.add(pivot);
        this.worldGroup.add(root);
        this.palletNodes.push({ data: pal, root, pivot });
      }

      // 6. 3D Exit Gates
      for (const gt of world.gates) {
        const gg = new THREE.Group();
        const cx = gt.x + gt.w / 2;
        const cz = gt.y + gt.h / 2;
        gg.position.set(cx, 0, cz);

        const pillarL = new THREE.Mesh(new THREE.BoxGeometry(26, 94, 48), stoneMat);
        pillarL.position.set(-gt.w / 2 - 8, 47, 0);
        pillarL.castShadow = true;
        gg.add(pillarL);

        const pillarR = new THREE.Mesh(new THREE.BoxGeometry(26, 94, 48), stoneMat);
        pillarR.position.set(gt.w / 2 + 8, 47, 0);
        pillarR.castShadow = true;
        gg.add(pillarR);

        const arch = new THREE.Mesh(new THREE.BoxGeometry(gt.w + 42, 18, 48), stoneCapMat);
        arch.position.set(0, 92, 0);
        gg.add(arch);

        const doorGroup = new THREE.Group();
        for (let bx = -gt.w / 2 + 12; bx <= gt.w / 2 - 12; bx += 22) {
          const bar = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 82, 8), ironMat);
          bar.position.set(bx, 41, 0);
          doorGroup.add(bar);
        }
        const crossBar = new THREE.Mesh(new THREE.BoxGeometry(gt.w, 8, 8), ironMat);
        crossBar.position.set(0, 42, 0);
        doorGroup.add(crossBar);
        gg.add(doorGroup);

        // Glowing Escape Floor Pad inside Exit Gate doorway
        const escapePadMat = new THREE.MeshBasicMaterial({
          color: 0x22c55e,
          transparent: true,
          opacity: 0.0,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const escapePad = new THREE.Mesh(new THREE.PlaneGeometry(gt.w - 8, 72), escapePadMat);
        escapePad.rotation.x = -Math.PI / 2;
        escapePad.position.set(0, 1.8, gt.id === "g_north" ? 16 : -16);
        gg.add(escapePad);

        this.worldGroup.add(gg);

        // Switch pedestal
        const swGroup = new THREE.Group();
        swGroup.position.set(gt.switchX, 0, gt.switchY);
        const swBox = new THREE.Mesh(new THREE.BoxGeometry(18, 36, 18), ironMat);
        swBox.position.y = 18;
        swGroup.add(swBox);
        const orbMat = new THREE.MeshStandardMaterial({
          color: 0x475569,
          emissive: 0x222222,
          emissiveIntensity: 1.2,
        });
        const orb = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 12), orbMat);
        orb.position.y = 40;
        swGroup.add(orb);
        this.worldGroup.add(swGroup);

        this.gateNodes.push({ data: gt, doorGroup, orbMat, escapePad, escapePadMat });
      }

      // 6b. 3D Vaultable Low Obstacles / Windows (Üstünden Atlanan Engeller)
      const vaultBaseMat = new THREE.MeshStandardMaterial({ color: 0x3b2c22, roughness: 0.85 });
      const vaultRailMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.55,
        roughness: 0.4,
      });
      if (world.vaults) {
        for (const vlt of world.vaults) {
          const vg = new THREE.Group();
          vg.position.set(vlt.x, 0, vlt.y);
          if (vlt.dir === "v") vg.rotation.y = Math.PI / 2;

          const baseWall = new THREE.Mesh(new THREE.BoxGeometry(76, 20, 18), vaultBaseMat);
          baseWall.position.y = 10;
          baseWall.castShadow = true;
          baseWall.receiveShadow = true;
          vg.add(baseWall);

          const topRail = new THREE.Mesh(new THREE.BoxGeometry(78, 5, 22), vaultRailMat);
          topRail.position.y = 22;
          vg.add(topRail);

          this.worldGroup.add(vg);
        }
      }

      // 7. 3D Kutsal Tılsımlar (Clockwork Runic Totems)
      for (const tot of world.totems) {
        const tg = new THREE.Group();
        tg.position.set(tot.x, 0, tot.y);

        const ped = new THREE.Mesh(new THREE.CylinderGeometry(24, 28, 12, 8), stoneMat);
        ped.position.y = 6;
        ped.castShadow = true;
        ped.receiveShadow = true;
        tg.add(ped);

        const core = new THREE.Mesh(new THREE.CylinderGeometry(11, 14, 34, 8), stoneCapMat);
        core.position.y = 26;
        core.castShadow = true;
        tg.add(core);

        const gearMat = new THREE.MeshStandardMaterial({ color: 0xb0863f, metalness: 0.72, roughness: 0.35 });
        const gear1 = new THREE.Mesh(new THREE.TorusGeometry(15, 2.6, 8, 16), gearMat);
        gear1.rotation.x = Math.PI / 2;
        gear1.position.y = 22;
        tg.add(gear1);

        const gear2 = new THREE.Mesh(new THREE.TorusGeometry(11, 2.2, 8, 14), gearMat);
        gear2.position.set(0, 32, 0);
        tg.add(gear2);

        const crystalMat = new THREE.MeshStandardMaterial({
          color: 0x38bdf8,
          emissive: 0x0284c7,
          emissiveIntensity: 0.9,
          roughness: 0.2,
        });
        const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(9, 0), crystalMat);
        crystal.position.y = 54;
        tg.add(crystal);

        const ringMat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.3,
        });
        const runeRing = new THREE.Mesh(new THREE.RingGeometry(27, 32, 24), ringMat);
        runeRing.rotation.x = -Math.PI / 2;
        runeRing.position.y = 1;
        tg.add(runeRing);

        const light = new THREE.PointLight(0x38bdf8, 0.55, 165);
        light.position.y = 58;
        tg.add(light);

        this.worldGroup.add(tg);
        this.totemNodes.push({ data: tot, gear1, gear2, crystal, crystalMat, ringMat, light });
      }

      // 8. 3D Kurban Kafesleri (Sacrificial Cages with Carry Glow & Light Pillars)
      for (const c of world.cages) {
        const cg = new THREE.Group();
        cg.position.set(c.x, 0, c.y);

        // Raised stone pedestal so cages stand out clearly
        const ped = new THREE.Mesh(new THREE.CylinderGeometry(32, 37, 10, 8), stoneMat);
        ped.position.y = 5;
        ped.receiveShadow = true;
        cg.add(ped);

        // Glowing ground rune ring
        const runeMat = new THREE.MeshBasicMaterial({
          color: 0xff5522,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.55,
        });
        const runeRing = new THREE.Mesh(new THREE.RingGeometry(33, 41, 24), runeMat);
        runeRing.rotation.x = -Math.PI / 2;
        runeRing.position.y = 1.2;
        cg.add(runeRing);

        // Shared mutable iron material for carry glow pulse
        const cageIronMat = new THREE.MeshStandardMaterial({
          color: 0x454a54,
          emissive: 0x330808,
          emissiveIntensity: 0.35,
          metalness: 0.72,
          roughness: 0.42,
        });

        // 4 thick corner posts & top frame
        const offsets = [-19, 19];
        for (const ox of offsets) {
          for (const oz of offsets) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 3.2, 66, 8), cageIronMat);
            post.position.set(ox, 42, oz);
            post.castShadow = true;
            cg.add(post);

            const spike = new THREE.Mesh(new THREE.ConeGeometry(4.2, 12, 6), cageIronMat);
            spike.position.set(ox, 79, oz);
            cg.add(spike);
          }
        }

        // Intermediate bars on all 4 sides
        for (const s of [-9, 0, 9]) {
          for (const edge of [-19, 19]) {
            const b1 = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 62, 6), cageIronMat);
            b1.position.set(s, 41, edge);
            cg.add(b1);
            const b2 = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 62, 6), cageIronMat);
            b2.position.set(edge, 41, s);
            cg.add(b2);
          }
        }

        const topCap = new THREE.Mesh(new THREE.BoxGeometry(44, 5, 44), cageIronMat);
        topCap.position.y = 74;
        cg.add(topCap);

        // Tall vertical Sacrificial Light Beam (visible when Werewolf carries a player!)
        const beamMat = new THREE.MeshBasicMaterial({
          color: 0xff7722,
          transparent: true,
          opacity: 0.0,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(14, 28, 240, 16, 1, true), beamMat);
        beam.position.y = 128;
        beam.visible = false;
        cg.add(beam);

        // Prisoner silhouette mesh inside cage
        const prisMesh = this._createMiniVillagerSilhouette(0xef4444);
        prisMesh.position.y = 10;
        prisMesh.visible = false;
        cg.add(prisMesh);

        // Permanent torch point light on each cage
        const light = new THREE.PointLight(0xff6622, 0.9, 210);
        light.position.y = 58;
        cg.add(light);

        this.worldGroup.add(cg);
        this.cageNodes.push({ data: c, cageIronMat, runeMat, runeRing, beam, beamMat, prisMesh, light });
      }

      // 9. Build 3D Player Meshes
      for (const p of Object.values(world.players)) {
        const node = p.role === "werewolf" ? this._createWerewolfNode(p) : this._createVillagerNode(p);
        this.worldGroup.add(node.root);
        this.playerNodes.set(p.id, node);
      }

      // 10. Dynamic FX Group (Scratch marks & blood pools)
      this._disposeGroup(this.fxGroup);
      this.worldGroup.add(this.fxGroup);
    }

    _createMiniVillagerSilhouette(hexColor) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color: hexColor,
        emissive: 0x550000,
        emissiveIntensity: 0.6,
        roughness: 0.7,
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(7, 10, 26, 8), mat);
      body.position.y = 16;
      g.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(6.5, 10, 10), mat);
      head.position.y = 34;
      g.add(head);
      return g;
    }

    _createWerewolfNode(p) {
      const root = new THREE.Group();
      root.position.set(p.x, 0, p.y);

      const bodyGroup = new THREE.Group();
      root.add(bodyGroup);

      const furMat = new THREE.MeshStandardMaterial({ color: 0x1d1a21, roughness: 0.85 });
      const furDarkMat = new THREE.MeshStandardMaterial({ color: 0x110f14, roughness: 0.9 });
      const clawMat = new THREE.MeshStandardMaterial({ color: 0xd6d3cd, roughness: 0.35, metalness: 0.4 });
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff1e2d });

      // Legs
      const legL = new THREE.Mesh(new THREE.BoxGeometry(9, 20, 10), furDarkMat);
      legL.position.set(-9, 10, 0);
      legL.castShadow = true;
      bodyGroup.add(legL);

      const legR = new THREE.Mesh(new THREE.BoxGeometry(9, 20, 10), furDarkMat);
      legR.position.set(9, 10, 0);
      legR.castShadow = true;
      bodyGroup.add(legR);

      // Muscular torso hunched forward (+Z is front!)
      const torso = new THREE.Mesh(new THREE.BoxGeometry(28, 26, 22), furMat);
      torso.position.set(0, 29, 2);
      torso.rotation.x = 0.25;
      torso.castShadow = true;
      bodyGroup.add(torso);

      // Dorsal spine spikes
      for (let i = 0; i < 3; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(3, 9, 5), furDarkMat);
        sp.position.set(0, 38 - i * 4, -7 - i * 3);
        sp.rotation.x = -0.6;
        bodyGroup.add(sp);
      }

      // Tail
      const tail = new THREE.Mesh(new THREE.ConeGeometry(4, 22, 6), furDarkMat);
      tail.position.set(0, 18, -14);
      tail.rotation.x = -1.1;
      bodyGroup.add(tail);

      // Wolf Head & Snout facing +Z
      const headGroup = new THREE.Group();
      headGroup.position.set(0, 44, 11);
      const skull = new THREE.Mesh(new THREE.BoxGeometry(16, 15, 16), furMat);
      headGroup.add(skull);
      const snout = new THREE.Mesh(new THREE.BoxGeometry(9, 8, 12), furDarkMat);
      snout.position.set(0, -2, 10);
      headGroup.add(snout);

      // Ears
      const earL = new THREE.Mesh(new THREE.ConeGeometry(3.5, 10, 5), furDarkMat);
      earL.position.set(-6, 10, -2);
      headGroup.add(earL);
      const earR = new THREE.Mesh(new THREE.ConeGeometry(3.5, 10, 5), furDarkMat);
      earR.position.set(6, 10, -2);
      headGroup.add(earR);

      // Glowing Crimson Eyes
      const eyeL = new THREE.Mesh(new THREE.SphereGeometry(2.1, 8, 8), eyeMat);
      eyeL.position.set(-4.2, 2.2, 8.2);
      headGroup.add(eyeL);
      const eyeR = new THREE.Mesh(new THREE.SphereGeometry(2.1, 8, 8), eyeMat);
      eyeR.position.set(4.2, 2.2, 8.2);
      headGroup.add(eyeR);
      bodyGroup.add(headGroup);

      // Articulated Arms + Claws
      const makeArm = (side) => {
        const arm = new THREE.Group();
        arm.position.set(side * 17, 34, 4);
        const limb = new THREE.Mesh(new THREE.BoxGeometry(8, 22, 9), furMat);
        limb.position.set(0, -8, 6);
        limb.rotation.x = -0.55;
        limb.castShadow = true;
        arm.add(limb);
        for (let c = -1; c <= 1; c++) {
          const claw = new THREE.Mesh(new THREE.ConeGeometry(1.3, 8, 5), clawMat);
          claw.position.set(c * 2.4, -17, 13);
          claw.rotation.x = Math.PI * 0.65;
          arm.add(claw);
        }
        return arm;
      };
      const armL = makeArm(-1);
      const armR = makeArm(1);
      bodyGroup.add(armL);
      bodyGroup.add(armR);

      // Carried Survivor Dummy slung over shoulder
      const carriedMesh = this._createMiniVillagerSilhouette(0xfbbf24);
      carriedMesh.rotation.z = Math.PI / 2;
      carriedMesh.position.set(-14, 38, -2);
      carriedMesh.visible = false;
      bodyGroup.add(carriedMesh);

      // Red Stain Ground Cone ahead (+Z: -PI/2 maps local -Y to +Z after rotation.x = -PI/2)
      const stainGeo = new THREE.CircleGeometry(175, 24, -Math.PI / 2 - 0.58, 1.16);
      const stainMat = new THREE.MeshBasicMaterial({
        color: 0xdc2626,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const stain = new THREE.Mesh(stainGeo, stainMat);
      stain.rotation.x = -Math.PI / 2;
      stain.position.set(0, 1.6, 8);
      root.add(stain);

      // Claw Slash Arc ahead (+Z, directly in front of the Werewolf's claws)
      const slashMat = new THREE.MeshBasicMaterial({
        color: 0xff3b3b,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      });
      const slashMesh = new THREE.Mesh(new THREE.RingGeometry(30, 50, 18, 1, -Math.PI / 2 - 0.9, 1.8), slashMat);
      slashMesh.rotation.x = -Math.PI / 2;
      slashMesh.position.set(0, 28, 18);
      slashMesh.visible = false;
      root.add(slashMesh);

      // Howl Aura Light
      const wolfLight = new THREE.PointLight(0xdc2626, 0.85, 220);
      wolfLight.position.set(0, 46, 12);
      root.add(wolfLight);

      return {
        role: "werewolf",
        root,
        bodyGroup,
        legL,
        legR,
        armL,
        armR,
        headGroup,
        carriedMesh,
        stain,
        slashMesh,
        wolfLight,
        prevX: p.x,
        prevY: p.y,
        walkPhase: 0,
      };
    }

    _createVillagerNode(p) {
      const root = new THREE.Group();
      root.position.set(p.x, 0, p.y);

      const bodyGroup = new THREE.Group();
      root.add(bodyGroup);

      const cloakColor = new THREE.Color(p.color || "#38bdf8").multiplyScalar(0.65);
      const cloakMat = new THREE.MeshStandardMaterial({ color: cloakColor, roughness: 0.85 });
      const darkClothMat = new THREE.MeshStandardMaterial({ color: 0x1b1e28, roughness: 0.9 });
      const skinMat = new THREE.MeshStandardMaterial({ color: 0xd1b399, roughness: 0.75 });
      const ironMat = new THREE.MeshStandardMaterial({ color: 0x3f4451, metalness: 0.6, roughness: 0.45 });

      const legL = new THREE.Mesh(new THREE.BoxGeometry(6.5, 16, 7), darkClothMat);
      legL.position.set(-5, 8, 0);
      legL.castShadow = true;
      bodyGroup.add(legL);

      const legR = new THREE.Mesh(new THREE.BoxGeometry(6.5, 16, 7), darkClothMat);
      legR.position.set(5, 8, 0);
      legR.castShadow = true;
      bodyGroup.add(legR);

      // Hooded cloak torso
      const cloak = new THREE.Mesh(new THREE.CylinderGeometry(8, 13, 26, 8), cloakMat);
      cloak.position.y = 26;
      cloak.castShadow = true;
      bodyGroup.add(cloak);

      // Head & Hood
      const head = new THREE.Mesh(new THREE.SphereGeometry(6.5, 10, 10), skinMat);
      head.position.set(0, 42, 1.5);
      bodyGroup.add(head);

      const hood = new THREE.Mesh(new THREE.ConeGeometry(9.5, 16, 8), cloakMat);
      hood.position.set(0, 44, -1);
      hood.rotation.x = -0.25;
      hood.castShadow = true;
      bodyGroup.add(hood);

      // Left arm
      const armL = new THREE.Mesh(new THREE.BoxGeometry(5.5, 18, 6), cloakMat);
      armL.position.set(-11, 28, 2);
      bodyGroup.add(armL);

      // Right arm holding Wrought-Iron Lantern (+Z front)
      const armR = new THREE.Group();
      armR.position.set(11, 32, 3);
      const armRMesh = new THREE.Mesh(new THREE.BoxGeometry(5.5, 16, 6), cloakMat);
      armRMesh.position.set(0, -4, 5);
      armRMesh.rotation.x = -0.6;
      armR.add(armRMesh);

      const lanternCage = new THREE.Mesh(new THREE.BoxGeometry(6, 9, 6), ironMat);
      lanternCage.position.set(0, -10, 13);
      armR.add(lanternCage);

      const flameMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
      const flame = new THREE.Mesh(new THREE.SphereGeometry(2.4, 8, 8), flameMat);
      flame.position.set(0, -10, 13);
      armR.add(flame);
      bodyGroup.add(armR);

      const lanternLight = new THREE.PointLight(0xffaa44, 0.95, 210);
      lanternLight.position.set(11, 28, 18);
      root.add(lanternLight);

      // Silver Lantern Flash Beam Cone (Q ability)
      const flashMat = new THREE.MeshBasicMaterial({
        color: 0xe0f2fe,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const flashCone = new THREE.Mesh(new THREE.ConeGeometry(88, 250, 16, 1, true), flashMat);
      flashCone.rotation.x = -Math.PI / 2;
      flashCone.position.set(0, 26, 135);
      flashCone.visible = false;
      root.add(flashCone);

      return {
        role: "villager",
        root,
        bodyGroup,
        legL,
        legR,
        armL,
        armR,
        lanternLight,
        flashCone,
        prevX: p.x,
        prevY: p.y,
        walkPhase: 0,
      };
    }

    _updateGroundFog(me, visibilityPoly, sightMax) {
      if (!this.fogCtx || !this.fogTex) return;
      const fctx = this.fogCtx;
      const scale = 0.25; // Maps 2400x1800 world to 600x450 texture
      fctx.globalCompositeOperation = "source-over";
      fctx.clearRect(0, 0, 600, 450);
      fctx.fillStyle = "rgba(4, 5, 10, 0.78)";
      fctx.fillRect(0, 0, 600, 450);

      if (visibilityPoly && visibilityPoly.length > 2) {
        const mx = me.x * scale;
        const my = me.y * scale;
        const sr = sightMax * scale;
        fctx.globalCompositeOperation = "destination-out";
        const grad = fctx.createRadialGradient(mx, my, 12, mx, my, sr);
        grad.addColorStop(0, "rgba(0,0,0,1)");
        grad.addColorStop(0.76, "rgba(0,0,0,0.92)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        fctx.fillStyle = grad;
        fctx.beginPath();
        fctx.moveTo(visibilityPoly[0].x * scale, visibilityPoly[0].y * scale);
        for (let i = 1; i < visibilityPoly.length; i++) {
          fctx.lineTo(visibilityPoly[i].x * scale, visibilityPoly[i].y * scale);
        }
        fctx.closePath();
        fctx.fill();
      }
      this.fogTex.needsUpdate = true;
    }

    updateAndRender(world, me, visibilityPoly = null, sightMax = 600) {
      if (!world || !me) return;
      const t = world.time;
      this._updateGroundFog(me, visibilityPoly, sightMax);

      // 1. Camera tracking
      const camX = world.camera.x + (Math.random() - 0.5) * world.camera.shake;
      const camZ = world.camera.y + (Math.random() - 0.5) * world.camera.shake;

      if (this.cameraMode === "overhead") {
        this.camera.position.set(camX, 710, camZ + 115);
      } else {
        this.camera.position.set(camX, 550, camZ + 335);
      }
      this.camera.lookAt(camX, 0, camZ);
      this.camera.updateMatrixWorld();

      // Keep moon shadow frustum centered near camera
      if (this.moonLight) {
        const sx = Math.round(camX / 40) * 40;
        const sz = Math.round(camZ / 40) * 40;
        this.moonLight.position.set(sx + 250, 950, sz + 180);
        this.moonLight.target.position.set(sx, 0, sz);
        this.moonLight.target.updateMatrixWorld();
      }

      // 2. Wind sway on trees
      for (const tr of this.treeMeshes) {
        tr.group.rotation.z = Math.sin(t * 1.4 + tr.phase) * 0.025;
      }

      // 3. Pallets state
      for (const pn of this.palletNodes) {
        if (pn.data.state === "broken") {
          pn.root.visible = false;
        } else if (pn.data.state === "dropped") {
          pn.root.visible = true;
          pn.pivot.rotation.x = 0;
          pn.pivot.position.y = 4;
        } else {
          pn.root.visible = true;
          pn.pivot.rotation.x = -1.28;
          pn.pivot.position.y = 14;
        }
      }

      // 4. Exit Gates
      for (const gn of this.gateNodes) {
        gn.doorGroup.position.y = gn.data.open ? 78 : gn.data.progress * 32;
        if (gn.data.open) {
          gn.orbMat.color.setHex(0x4ade80);
          gn.orbMat.emissive.setHex(0x22c55e);
          if (gn.escapePad) {
            gn.escapePad.visible = true;
            gn.escapePadMat.opacity = 0.42 + 0.18 * Math.sin(t * 5);
          }
        } else if (world.powered) {
          gn.orbMat.color.setHex(0xfbbf24);
          gn.orbMat.emissive.setHex(0xd97706);
          if (gn.escapePad) gn.escapePad.visible = false;
        } else {
          gn.orbMat.color.setHex(0x475569);
          gn.orbMat.emissive.setHex(0x111111);
          if (gn.escapePad) gn.escapePad.visible = false;
        }
      }

      // 5. Totems (spinning clockwork gears + arcane crystal)
      for (const tn of this.totemNodes) {
        const prog = tn.data.progress;
        const spin = tn.data.done ? 3.4 : 0.4 + prog * 2.4;
        tn.gear1.rotation.z = t * spin;
        tn.gear2.rotation.y = -t * spin * 1.3;
        tn.crystal.rotation.y = t * 1.8;
        tn.crystal.position.y = 54 + Math.sin(t * 2.8) * 3.5;

        if (tn.data.done) {
          tn.crystalMat.color.setHex(0x4ade80);
          tn.crystalMat.emissive.setHex(0x22c55e);
          tn.crystalMat.emissiveIntensity = 1.6;
          tn.ringMat.color.setHex(0x4ade80);
          tn.ringMat.opacity = 0.72;
          tn.light.color.setHex(0x4ade80);
          tn.light.intensity = 1.3;
        } else {
          tn.crystalMat.color.setHex(0x38bdf8);
          tn.crystalMat.emissive.setHex(0x0284c7);
          tn.crystalMat.emissiveIntensity = 0.6 + prog * 1.1;
          tn.ringMat.opacity = 0.25 + prog * 0.45;
          tn.light.intensity = 0.55 + prog * 0.65;
        }
      }

      // 6. Kurban Kafesleri (Bright Carry Glow + Sacrificial Light Pillars!)
      const wolf = Object.values(world.players).find((pl) => pl.role === "werewolf");
      const isCarryingAny = !!(wolf && wolf.carryingId);
      const pulse = 0.5 + 0.5 * Math.sin(t * 7.5);

      for (const cn of this.cageNodes) {
        const hasPrisoner = !!cn.data.prisonerId;
        cn.prisMesh.visible = hasPrisoner;

        if (hasPrisoner) {
          cn.cageIronMat.emissive.setHex(0xdc2626);
          cn.cageIronMat.emissiveIntensity = 0.75 + pulse * 0.65;
          cn.runeMat.color.setHex(0xef4444);
          cn.runeMat.opacity = 0.7 + pulse * 0.28;
          cn.runeRing.scale.setScalar(1.05 + pulse * 0.12);
          cn.beam.visible = true;
          cn.beamMat.color.setHex(0xef4444);
          cn.beamMat.opacity = 0.2 + pulse * 0.15;
          cn.light.color.setHex(0xef4444);
          cn.light.intensity = 1.8 + pulse * 0.8;
        } else if (isCarryingAny) {
          // CARRYING GLOW: Intense pulsing Crimson-Gold beacon & tall 3D light pillar!
          const glowHex = pulse > 0.5 ? 0xffaa00 : 0xff2a00;
          cn.cageIronMat.emissive.setHex(glowHex);
          cn.cageIronMat.emissiveIntensity = 1.25 + pulse * 1.1;
          cn.runeMat.color.setHex(0xffbb22);
          cn.runeMat.opacity = 0.78 + pulse * 0.22;
          cn.runeRing.scale.setScalar(1.12 + pulse * 0.22);
          cn.beam.visible = true;
          cn.beamMat.color.setHex(glowHex);
          cn.beamMat.opacity = 0.28 + pulse * 0.24;
          cn.light.color.setHex(0xff7711);
          cn.light.intensity = 2.6 + pulse * 1.2;
          cn.light.distance = 320;
        } else {
          // Normal high-visibility pedestal glow so cages are always easy to spot
          cn.cageIronMat.emissive.setHex(0x441008);
          cn.cageIronMat.emissiveIntensity = 0.45;
          cn.runeMat.color.setHex(0xff5522);
          cn.runeMat.opacity = 0.48 + 0.15 * Math.sin(t * 3);
          cn.runeRing.scale.setScalar(1.0);
          cn.beam.visible = false;
          cn.light.color.setHex(0xff6622);
          cn.light.intensity = 0.95;
          cn.light.distance = 210;
        }
      }

      // 7. Dynamic 3D Players & Visibility Occlusion
      for (const p of Object.values(world.players)) {
        const node = this.playerNodes.get(p.id);
        if (!node) continue;

        const hiddenState =
          p.state === "escaped" || p.state === "dead" || p.state === "caged" || !!p.inLockerId;

        if (hiddenState) {
          node.root.visible = false;
          continue;
        }

        // Strict Line-of-Sight check for opponents (same as 2D engine)
        const isSelf = p.id === me.id;
        const isAlly = me.role === "villager" && p.role === "villager";
        const sightMax = me.role === "werewolf" ? 690 : 560;
        const visibleInSight = isSelf || isAlly || (world._hasLOS ? world._hasLOS(me.x, me.y, p.x, p.y, sightMax) : true);

        node.root.visible = visibleInSight;
        if (!visibleInSight) continue;

        const vaultY =
          p.vaultTimer > 0 && p.vaultDur
            ? Math.sin(Math.max(0, Math.min(1, 1 - p.vaultTimer / p.vaultDur)) * Math.PI) * 26
            : 0;
        node.root.position.set(p.x, vaultY, p.y);
        node.root.rotation.y = Math.PI / 2 - p.angle;

        // Calculate stride speed for animation
        const moved = Math.hypot(p.x - node.prevX, p.y - node.prevY);
        node.prevX = p.x;
        node.prevY = p.y;
        if (moved > 0.25) {
          node.walkPhase += Math.min(0.45, moved * 0.13);
        } else {
          node.walkPhase *= 0.85;
        }

        const swing = moved > 0.25 ? Math.sin(node.walkPhase) * 0.55 : 0;

        if (p.role === "werewolf") {
          node.legL.rotation.x = swing;
          node.legR.rotation.x = -swing;
          node.armL.rotation.x = -swing * 0.65;
          node.armR.rotation.x = swing * 0.65;
          node.carriedMesh.visible = !!p.carryingId;
          node.slashMesh.visible = p.lungeTimer > 0;
          node.stain.visible = p.stunTimer <= 0;

          if (p.lungeTimer > 0) {
            node.armL.rotation.x = -1.2;
            node.armR.rotation.x = -1.2;
          }
          if (p.stunTimer > 0) {
            node.headGroup.rotation.z = Math.sin(t * 28) * 0.35;
          } else {
            node.headGroup.rotation.z = 0;
          }
          node.wolfLight.intensity = p.howlActiveTimer > 0 ? 2.2 : 0.85;
        } else {
          if (p.hp === 0) {
            // Downed crawling pose
            node.bodyGroup.rotation.x = Math.PI / 2;
            node.bodyGroup.position.y = 10;
            node.legL.rotation.x = swing * 0.4;
            node.legR.rotation.x = -swing * 0.4;
          } else {
            node.bodyGroup.rotation.x = p.channel ? 0.22 : 0;
            node.bodyGroup.position.y = 0;
            node.legL.rotation.x = swing;
            node.legR.rotation.x = -swing;
            node.armL.rotation.x = p.channel ? -0.7 + Math.sin(t * 14) * 0.25 : -swing * 0.5;
            node.armR.rotation.x = swing * 0.3;
          }
          node.flashCone.visible = p.flashlightBurstTimer > 0;
        }
      }

      // 8. Render 3D Scratch Marks & Blood Pools dynamically
      this._syncGroundDecals(world, me);

      this.renderer.render(this.scene, this.camera);
    }

    _syncGroundDecals(world, me) {
      // Reuse lightweight pool of ground decal meshes so zero GC pressure
      if (!this._decalPool) {
        this._decalPool = [];
        this._bloodGeo = new THREE.CircleGeometry(1, 8);
        this._scratchGeo = new THREE.PlaneGeometry(14, 3);
      }
      let idx = 0;

      const getDecal = (geo, colorHex, opacity) => {
        let m = this._decalPool[idx];
        if (!m) {
          m = new THREE.Mesh(
            geo,
            new THREE.MeshBasicMaterial({
              color: colorHex,
              transparent: true,
              opacity,
              side: THREE.DoubleSide,
              depthWrite: false,
            })
          );
          m.rotation.x = -Math.PI / 2;
          this.fxGroup.add(m);
          this._decalPool[idx] = m;
        } else {
          if (m.geometry !== geo) m.geometry = geo;
          m.material.color.setHex(colorHex);
          m.material.opacity = opacity;
        }
        m.visible = true;
        idx++;
        return m;
      };

      const maxPools = Math.min(world.bloodPools.length, 60);
      for (let i = 0; i < maxPools; i++) {
        const bp = world.bloodPools[i];
        const m = getDecal(this._bloodGeo, 0x991118, Math.min(0.75, bp.life * 0.14));
        m.scale.set(bp.r, bp.r, 1);
        m.rotation.z = 0;
        m.position.set(bp.x, 0.8, bp.y);
      }

      if (me.role === "werewolf") {
        const boost = me.instinctActiveTimer > 0 ? 1.0 : 0.7;
        const maxScr = Math.min(world.scratches.length, 90);
        for (let i = 0; i < maxScr; i++) {
          const sc = world.scratches[i];
          const alpha = (sc.life / sc.maxLife) * boost;
          const m = getDecal(this._scratchGeo, 0xff4422, alpha);
          m.scale.set(1, 1, 1);
          m.rotation.z = (i % 5) * 0.6;
          m.position.set(sc.x, 1.0, sc.y);
        }
      }

      for (let j = idx; j < this._decalPool.length; j++) {
        this._decalPool[j].visible = false;
      }
    }

    screenToWorld(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, rect.width || window.innerWidth);
      const h = Math.max(1, rect.height || window.innerHeight);
      this.tmpNdc.set(((clientX - rect.left) / w) * 2 - 1, -((clientY - rect.top) / h) * 2 + 1);
      this.raycaster.setFromCamera(this.tmpNdc, this.camera);
      const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.tmpGroundHit);
      if (hit) {
        return { x: hit.x, y: hit.z };
      }
      return { x: 1200, y: 900 };
    }

    worldToScreen(wx, wy, height = 0) {
      const w = this.canvas.width || window.innerWidth;
      const h = this.canvas.height || window.innerHeight;
      this.tmpVec.set(wx, height, wy).project(this.camera);
      return {
        x: (this.tmpVec.x * 0.5 + 0.5) * w,
        y: (-this.tmpVec.y * 0.5 + 0.5) * h,
        visible: this.tmpVec.z <= 1,
      };
    }
  }

  window.GothicRenderer3D = GothicRenderer3D;
})();
