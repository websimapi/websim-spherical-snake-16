import * as THREE from 'three';
import { calculateIslandHeight, createIslandMesh } from './island-geometry.js';

export class IslandGenerator {
    constructor(scene) {
        this.scene = scene;
        this.mesh = null;
        this.center = new THREE.Vector3(0, 1, 0); // Target center direction on Earth
        this.seed = new THREE.Vector3(0, 0, 0);
        this.state = 'inactive'; // inactive, spawning, docked
        this.progress = 0; 
        this.baseRadius = 10; 
        
        // Reusable vectors for physics to avoid garbage
        this._localDir = new THREE.Vector3();
        this._dummyQ = new THREE.Quaternion();

        // Combined Uniforms (Sand Physics + Tides)
        this.sandUniforms = {
            uSnakePoints: { value: new Array(20).fill().map(() => new THREE.Vector3()) },
            uSnakeCount: { value: 0 },
            uTime: { value: 0 },
            uGlobalScale: { value: 1.0 },
            // Tides / Ripples - References will be copied from Game
            uRippleCenters: { value: new Array(5).fill().map(() => new THREE.Vector3()) },
            uRippleStartTimes: { value: new Array(5).fill(-1000) },
            uRippleIntensities: { value: new Array(5).fill(0) },
            uEarthRadius: { value: 10.0 },
            uHeat: { value: 0.0 } // 1 = Hot core, 0 = Normal
        };
    }

    setRippleUniforms(rippleUniforms) {
        // Link our uniforms to the game's ripple uniforms for synchronization
        this.sandUniforms.uRippleCenters = rippleUniforms.uRippleCenters;
        this.sandUniforms.uRippleStartTimes = rippleUniforms.uRippleStartTimes;
        this.sandUniforms.uRippleIntensities = rippleUniforms.uRippleIntensities;
        this.sandUniforms.uTime = rippleUniforms.uTime;
    }

    trigger(earthRadius) {
        if (this.state !== 'inactive') return;
        
        // 1. Determine Location
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        
        this.center.set(
            Math.sin(phi) * Math.cos(theta),
            Math.sin(phi) * Math.sin(theta),
            Math.cos(phi)
        ).normalize();

        // Generate unique seed
        this.seed.set(
            Math.random() * 1000,
            Math.random() * 1000,
            Math.random() * 1000
        );
        
        // 2. Generate Proper Mesh
        this.createMesh(this.baseRadius, this.seed);
        
        // 3. Start Animation
        this.state = 'spawning';
        this.progress = 0;
        this.mesh.visible = true;
        
        // Reset heat
        this.sandUniforms.uHeat.value = 1.0;
    }

    createMesh(radius, seed) {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            if(this.mesh.geometry) this.mesh.geometry.dispose();
            if(this.mesh.material) this.mesh.material.dispose();
        }

        // Generate the detailed terrain mesh
        this.mesh = createIslandMesh(radius, seed);
        
        // Inject Sand Physics + Heat Shader
        this.mesh.material.onBeforeCompile = (shader) => {
            shader.uniforms.uSnakePoints = this.sandUniforms.uSnakePoints;
            shader.uniforms.uSnakeCount = this.sandUniforms.uSnakeCount;
            shader.uniforms.uGlobalScale = this.sandUniforms.uGlobalScale;
            shader.uniforms.uHeat = this.sandUniforms.uHeat;
            
            shader.uniforms.uTime = this.sandUniforms.uTime;
            shader.uniforms.uRippleCenters = this.sandUniforms.uRippleCenters;
            shader.uniforms.uRippleStartTimes = this.sandUniforms.uRippleStartTimes;
            shader.uniforms.uRippleIntensities = this.sandUniforms.uRippleIntensities;

            shader.vertexShader = `
                uniform vec3 uSnakePoints[20];
                uniform int uSnakeCount;
                uniform float uGlobalScale;
                varying vec3 vWorldPos;
                varying float vIsBeach;
                varying float vHeightNorm; 
            ` + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
                #include <begin_vertex>
                
                vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
                vWorldPos = worldPosition.xyz;

                // Pass height info to fragment for heat gradient
                // transformed length relative to base radius
                vHeightNorm = (length(transformed) - 10.0);

                vIsBeach = 0.0;
                #ifdef USE_COLOR
                    if (color.r > 0.6 && color.g > 0.5) {
                        vIsBeach = 1.0;
                    }
                #endif

                if (vIsBeach > 0.5 && uSnakeCount > 0) {
                    vec3 accumulatedOffset = vec3(0.0);
                    for(int i = 0; i < 20; i++) {
                        if (i >= uSnakeCount) break;
                        vec3 sPos = uSnakePoints[i];
                        float dist = distance(worldPosition.xyz, sPos);
                        float radius = 1.5 * uGlobalScale;
                        if (dist < radius) {
                            float strength = pow(1.0 - (dist / radius), 2.0);
                            vec3 dir = normalize(worldPosition.xyz - sPos);
                            accumulatedOffset += dir * strength * 0.5 * uGlobalScale;
                            accumulatedOffset += normal * strength * 0.35 * uGlobalScale;
                        }
                    }
                    transformed += accumulatedOffset;
                }
                `
            );
            
            const rippleFrag = `
                uniform float uTime;
                uniform vec3 uRippleCenters[5];
                uniform float uRippleStartTimes[5];
                uniform float uRippleIntensities[5];
                varying vec3 vWorldPos;
                varying float vIsBeach;
                
                float getRippleAt(vec3 pos) {
                    float total = 0.0;
                    vec3 pNorm = normalize(pos);
                    for(int i=0; i<5; i++) {
                        float startTime = uRippleStartTimes[i];
                        if (startTime < 0.0) continue;
                        float age = uTime - startTime;
                        if (age < 0.0 || age > 2.0) continue;
                        vec3 center = uRippleCenters[i];
                        float intensity = uRippleIntensities[i];
                        float dotProd = dot(pNorm, normalize(center));
                        float angle = acos(clamp(dotProd, -1.0, 1.0));
                        float dist = angle * 10.0;
                        float speed = 8.0; 
                        float waveCenter = age * speed;
                        float distDiff = dist - waveCenter;
                        if (abs(distDiff) < 2.0) {
                            float ripple = sin(distDiff * 3.0) * exp(-distDiff * distDiff);
                            ripple *= (1.0 - age / 2.0);
                            ripple *= intensity;
                            total += ripple;
                        }
                    }
                    return total;
                }
            `;

            shader.fragmentShader = `uniform float uHeat;\nvarying float vHeightNorm;\n` + rippleFrag + shader.fragmentShader;
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                
                // Heat / Magma Effect
                if (uHeat > 0.01) {
                     // Glow hotter at the bottom/center
                     float heatGlow = smoothstep(0.5, -0.5, vHeightNorm) * uHeat;
                     
                     // Magma colors
                     vec3 magmaColor = mix(vec3(1.0, 0.2, 0.0), vec3(1.0, 0.9, 0.2), heatGlow);
                     
                     // Pulse/Noise effect for magma
                     float noise = sin(vWorldPos.x * 2.0 + uTime * 5.0) * sin(vWorldPos.z * 2.0);
                     magmaColor += vec3(0.2) * noise * uHeat;
                     
                     gl_FragColor.rgb = mix(gl_FragColor.rgb, magmaColor, uHeat * 0.8);
                     
                     // Add emissive punch
                     gl_FragColor.rgb += magmaColor * uHeat * 0.5;
                }

                if (vIsBeach > 0.5) {
                    float rVal = getRippleAt(vWorldPos);
                    if (abs(rVal) > 0.05) {
                        float wet = smoothstep(0.05, 0.3, abs(rVal));
                        vec3 wetColor = gl_FragColor.rgb * 0.6 + vec3(0.1, 0.2, 0.3) * 0.2;
                        gl_FragColor.rgb = mix(gl_FragColor.rgb, wetColor, wet * 0.8);
                    }
                }`
            );
        };

        // Align mesh to the target center
        // The mesh is generated at North Pole (0, 1, 0)
        // We rotate it to align (0, 1, 0) with this.center
        const alignQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.center);
        this.mesh.quaternion.copy(alignQ);
        
        // Initially scale down for spawn effect
        this.mesh.scale.set(0.1, 0.1, 0.1);
        
        this.scene.add(this.mesh);
    }

    // Get height at a specific direction (normalized) relative to sphere center
    getHeightAndNormal(direction, earthRadius) {
        if ((this.state !== 'docked' && this.state !== 'spawning') || !this.mesh) return { height: 0, normal: direction.clone() };

        // Scale Factor (Earth has grown, island grows with it)
        const scale = earthRadius / this.baseRadius;

        // 1. Transform world direction into Island Local Space (where island is at North Pole)
        const invQ = this.mesh.quaternion.clone().invert();
        const localDir = direction.clone().applyQuaternion(invQ); 

        // Restrict influence to top hemisphere to prevent antipodal glitches
        // Cos(72deg) is approx 0.3. Using 0.4 for tighter safety margin.
        if (localDir.y < 0.4) return { height: 0, normal: direction.clone() };
        
        // 2. Calculate coordinates on the BASE sphere
        const px = localDir.x * this.baseRadius;
        const py = localDir.y * this.baseRadius;
        const pz = localDir.z * this.baseRadius;
        
        // 3. Get Base Height using Seed
        const hBase = calculateIslandHeight(px, py, pz, this.baseRadius, this.seed);
        
        if (hBase <= 0.001) return { height: 0, normal: direction.clone() };
        
        // 4. Calculate Normal (Finite Difference approximation in Base Space)
        const eps = 0.1;
        const hx = calculateIslandHeight(px + eps, py, pz, this.baseRadius, this.seed);
        const hz = calculateIslandHeight(px, py, pz + eps, this.baseRadius, this.seed);
        
        // Slopes
        const dhdx = (hx - hBase) / eps;
        const dhdz = (hz - hBase) / eps;
        
        const localNormal = new THREE.Vector3(-dhdx, 1, -dhdz).normalize();
        
        // 5. Transform normal back to world space
        const worldNormal = localNormal.applyQuaternion(this.mesh.quaternion);

        // 6. Calculate Final Height
        // Scale the base height directly.
        // We clamp to 0 to ensure snake stays on water surface when over the underwater skirt,
        // effectively treating the ocean as a solid floor at height 0.
        const hPhysical = Math.max(0, hBase * scale);

        return { height: hPhysical, normal: worldNormal };
    }

    update(dt, earthRadius, snake) {
        if (this.state === 'inactive') return;
        
        // Always maintain scale ratio with Earth growth
        const globalScale = earthRadius / this.baseRadius;
        this.sandUniforms.uGlobalScale.value = globalScale;

        // Update Snake Uniforms
        if (snake && snake.segments) {
            let count = 0;
            
            // Add head
            if (count < 20) {
                this.sandUniforms.uSnakePoints.value[count].copy(snake.head.position);
                count++;
            }
            
            // Add segments (stride to save uniforms)
            for(let i=0; i<snake.segments.length; i+=2) {
                if (count >= 20) break;
                this.sandUniforms.uSnakePoints.value[count].copy(snake.segments[i].position);
                count++;
            }
            this.sandUniforms.uSnakeCount.value = count;
        }

        if (this.state === 'docked') {
             if (this.mesh) {
                 this.mesh.scale.setScalar(globalScale);
             }
             // Ensure heat is off
             if (this.sandUniforms.uHeat.value > 0) this.sandUniforms.uHeat.value = 0;
             return;
        }
        
        // 10 Second Animation
        this.progress += dt * 0.1; 
        
        if (this.progress >= 1.0) {
            this.progress = 1.0;
            this.state = 'docked';
            this.mesh.scale.setScalar(globalScale);
            this.sandUniforms.uHeat.value = 0.0;
        } else {
            const p = this.progress;
            
            // Scale: Grows from 0.1 to 1.0
            // Non-linear ease out for "heavy" feel
            const animScale = 0.1 + 0.9 * (1.0 - Math.pow(1.0 - p, 3.0));
            
            this.mesh.scale.setScalar(globalScale * animScale);
            
            // Heat: Starts high, cools down
            // Hot for first 3 seconds (0.3), then fades
            let heat = 0;
            if (p < 0.3) {
                heat = 1.0;
            } else {
                heat = 1.0 - (p - 0.3) / 0.7;
            }
            this.sandUniforms.uHeat.value = Math.max(0, heat);
        }
    }
}