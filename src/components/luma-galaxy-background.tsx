"use client";

import { useEffect, useRef } from "react";

type LumaGalaxyBackgroundProps = {
  className?: string;
  speed?: number;
};

export function LumaGalaxyBackground({ className, speed = 1 }: LumaGalaxyBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const speedRef = useRef(speed);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;

    function syncSize() {
      const width = canvas.clientWidth || 1280;
      const height = canvas.clientHeight || 720;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
      const nextWidth = Math.floor(width * pixelRatio);
      const nextHeight = Math.floor(height * pixelRatio);
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
    }

    syncSize();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncSize) : null;
    observer?.observe(canvas);
    window.addEventListener("resize", syncSize);

    const glContext = (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!glContext) return () => observer?.disconnect();
    const gl = glContext;

    const vertexShaderSource = `
      attribute vec2 a_position;
      varying vec2 v_texCoord;
      void main() {
        v_texCoord = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fragmentShaderSource = `
      precision highp float;
      varying vec2 v_texCoord;
      uniform float u_time;
      uniform vec2 u_resolution;
      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }

      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
          v += a * noise(p);
          p *= 2.0;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.y, u_resolution.x);
        float t = u_time * 0.05;

        float angle = atan(uv.y, uv.x);
        float dist = length(uv);
        angle += dist * 2.0 - t * 2.0;

        float spiral = 0.0;
        for(float i = 0.0; i < 3.0; i++) {
          float a = angle + i * 2.094;
          float s = pow(max(0.0, 1.0 - abs(fract(a / 6.28 + dist * 0.5) - 0.5) * 10.0), 3.0);
          spiral += s * exp(-dist * 2.0);
        }

        vec2 nebulaUV = uv * 2.0;
        float n1 = fbm(nebulaUV + t);
        float n2 = fbm(nebulaUV - t * 0.5 + n1);

        vec3 color1 = vec3(0.1, 0.2, 0.5);
        vec3 color2 = vec3(0.4, 0.1, 0.6);
        vec3 color3 = vec3(0.0, 0.8, 0.9);
        vec3 color4 = vec3(0.9, 0.8, 0.6);

        vec3 nebulaColor = mix(color1, color2, n1);
        nebulaColor = mix(nebulaColor, color3, n2 * 0.5);
        nebulaColor *= (n1 + n2) * 0.5;

        float stars = pow(hash(uv + floor(t)), 50.0) * 2.0;
        stars += pow(hash(uv * 1.5 + 10.0), 100.0) * 5.0;

        float core = exp(-dist * 6.0) * 1.5;
        vec3 coreColor = mix(color4, vec3(1.0), core);

        vec3 finalColor = nebulaColor * 1.2;
        finalColor += spiral * color3 * 0.5;
        finalColor += stars * (0.8 + 0.2 * sin(u_time + hash(uv) * 10.0));
        finalColor += core * coreColor;
        finalColor *= smoothstep(1.2, 0.4, dist);

        gl_FragColor = vec4(finalColor, 1.0);
      }
    `;

    function compileShader(type: number, source: string) {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    }

    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    const program = gl.createProgram();

    if (!vertexShader || !fragmentShader || !program) {
      return () => observer?.disconnect();
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, "u_time");
    const uResolution = gl.getUniformLocation(program, "u_resolution");
    let frame = 0;
    const onVisibilityChange = () => {
      if (!document.hidden && !frame) frame = requestAnimationFrame(render);
    };

    function render(time: number) {
      if (document.hidden) {
        frame = 0;
        return;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (uTime) gl.uniform1f(uTime, time * 0.001 * speedRef.current);
      if (uResolution) gl.uniform2f(uResolution, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frame = requestAnimationFrame(render);
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (!document.hidden) frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", syncSize);
      observer?.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
