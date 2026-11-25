"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export type LumaCoreSceneNode = {
  id: string;
  label: string;
  tone: "cyan" | "violet" | "amber" | "rose";
  status?: "idle" | "running" | "attention";
};

type LumaCoreSceneProps = {
  nodes: LumaCoreSceneNode[];
  focusedNodeId?: string;
  onNodeSelect?: (nodeId: string) => void;
  className?: string;
};

const toneColors: Record<LumaCoreSceneNode["tone"], number> = {
  cyan: 0x67e8f9,
  violet: 0xc4b5fd,
  amber: 0xfbbf24,
  rose: 0xfb7185,
};

const nodePositions = [
  new THREE.Vector3(0, 2.45, 0.15),
  new THREE.Vector3(2.25, 1.25, 0.15),
  new THREE.Vector3(2.05, -1.45, 0.1),
  new THREE.Vector3(0.05, -2.35, 0.2),
  new THREE.Vector3(-2.05, -1.35, 0.1),
  new THREE.Vector3(-2.25, 1.25, 0.15),
  new THREE.Vector3(0, 0, 0.85),
];

export function LumaCoreScene({ nodes, focusedNodeId, onNodeSelect, className }: LumaCoreSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const focusedNodeRef = useRef(focusedNodeId);
  const onNodeSelectRef = useRef(onNodeSelect);

  useEffect(() => {
    focusedNodeRef.current = focusedNodeId;
    onNodeSelectRef.current = onNodeSelect;
  }, [focusedNodeId, onNodeSelect]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(0, 0, 10.5);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    mount.appendChild(renderer.domElement);

    const core = new THREE.Group();
    scene.add(core);

    const graphite = new THREE.MeshBasicMaterial({
      color: 0x07131c,
      transparent: true,
      opacity: 0.9,
    });
    const innerCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.86, 2), graphite);
    core.add(innerCore);

    const wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.52,
      wireframe: true,
    });
    const wireCore = new THREE.Mesh(new THREE.IcosahedronGeometry(1.03, 2), wireMaterial);
    wireCore.rotation.set(0.25, 0.5, 0.1);
    core.add(wireCore);

    const ringSpecs = [
      { radius: 1.46, tube: 0.018, color: 0x67e8f9, opacity: 0.68, rotation: [0.1, 0.55, 0.18] },
      { radius: 1.78, tube: 0.012, color: 0xc4b5fd, opacity: 0.42, rotation: [1.12, 0.2, -0.4] },
      { radius: 2.12, tube: 0.009, color: 0x64748b, opacity: 0.42, rotation: [0.2, 1.1, 0.35] },
    ] as const;
    const rings = ringSpecs.map((spec) => {
      const material = new THREE.MeshBasicMaterial({
        color: spec.color,
        transparent: true,
        opacity: spec.opacity,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(spec.radius, spec.tube, 8, 128), material);
      ring.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
      core.add(ring);
      return ring;
    });

    const pathMaterial = new THREE.LineBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.2,
    });
    const paths = nodePositions.map((position) => {
      const points = [
        new THREE.Vector3(0, 0, 0.15),
        new THREE.Vector3(position.x * 0.38, position.y * 0.38, 0.25),
        new THREE.Vector3(position.x * 0.74, position.y * 0.74, 0.12),
        position,
      ];
      const curve = new THREE.CatmullRomCurve3(points);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)), pathMaterial.clone());
      core.add(line);
      return line;
    });

    const nodeGroups = nodes.slice(0, nodePositions.length).map((node, index) => {
      const group = new THREE.Group();
      group.position.copy(nodePositions[index]);
      group.userData.nodeId = node.id;
      const color = toneColors[node.tone];
      const nodeMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 });
      const nodeMesh = new THREE.Mesh(new THREE.SphereGeometry(index === 6 ? 0.13 : 0.1, 12, 12), nodeMaterial);
      nodeMesh.userData.nodeId = node.id;
      group.add(nodeMesh);
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(index === 6 ? 0.2 : 0.16, index === 6 ? 0.218 : 0.176, 32),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.46, side: THREE.DoubleSide }),
      );
      halo.rotation.x = -Math.PI / 2;
      group.add(halo);
      core.add(group);
      return { group, nodeMesh, halo, node };
    });

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

    function syncSize() {
      const width = mount?.clientWidth || 680;
      const height = mount?.clientHeight || 620;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    function updatePointer(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      pointerY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      pointer.set(pointerX, -pointerY);
    }

    function handlePointerMove(event: PointerEvent) {
      updatePointer(event);
      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(nodeGroups.map(({ nodeMesh }) => nodeMesh), false);
      renderer.domElement.style.cursor = intersections.length > 0 ? "pointer" : "default";
    }

    function handlePointerLeave() {
      pointerX = 0;
      pointerY = 0;
      renderer.domElement.style.cursor = "default";
    }

    function handleClick(event: PointerEvent) {
      updatePointer(event);
      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(nodeGroups.map(({ nodeMesh }) => nodeMesh), false);
      const nodeId = intersections[0]?.object.userData.nodeId;
      if (typeof nodeId === "string") onNodeSelectRef.current?.(nodeId);
    }

    function render(time: number) {
      const motion = reducedMotion ? 0.15 : 1;
      const seconds = time * 0.001;
      core.rotation.y += 0.00032 * motion;
      core.rotation.x += 0.00008 * motion;
      core.rotation.z = THREE.MathUtils.lerp(core.rotation.z, pointerX * 0.06, 0.025);
      core.position.y = THREE.MathUtils.lerp(core.position.y, -pointerY * 0.12, 0.025);
      innerCore.rotation.y = seconds * 0.12 * motion;
      wireCore.rotation.y = -seconds * 0.16 * motion;
      wireCore.rotation.x = seconds * 0.09 * motion;
      rings[0].rotation.z += 0.0007 * motion;
      rings[1].rotation.y -= 0.00042 * motion;
      rings[2].rotation.x += 0.00025 * motion;

      nodeGroups.forEach(({ group, nodeMesh, halo, node }) => {
        const isFocused = node.id === focusedNodeRef.current;
        const isAttention = node.status === "attention";
        const pulse = isFocused ? 1 + Math.sin(seconds * 2.4) * 0.12 : 1 + Math.sin(seconds * 1.3 + group.position.x) * 0.035;
        const scale = isAttention ? pulse * 1.12 : pulse;
        group.scale.setScalar(scale);
        nodeMesh.material.opacity = isFocused ? 1 : isAttention ? 0.88 : 0.68;
        halo.material.opacity = isFocused ? 0.8 : isAttention ? 0.52 : 0.28;
        halo.scale.setScalar(isFocused ? 1.18 : 1);
      });

      paths.forEach((path, index) => {
        const material = path.material as THREE.LineBasicMaterial;
        const node = nodes[index];
        const isFocused = node?.id === focusedNodeRef.current;
        material.opacity = isFocused ? 0.8 : node?.status === "attention" ? 0.5 : 0.16;
      });

      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    }

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncSize) : null;
    observer?.observe(mount);
    syncSize();
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    renderer.domElement.addEventListener("click", handleClick);
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.dispose();
      scene.traverse((object) => {
        const disposable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        disposable.geometry?.dispose();
        if (Array.isArray(disposable.material)) disposable.material.forEach((material) => material.dispose());
        else disposable.material?.dispose();
      });
      mount.removeChild(renderer.domElement);
    };
  }, [nodes]);

  return <div ref={mountRef} className={className} aria-label="流光创作引擎核心场景" role="img" />;
}
