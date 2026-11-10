import { cpus, freemem, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import type { VoiceResourceStats } from "../../shared/voice";

interface SystemCpuTimes {
    idle: number;
    total: number;
}

export function createResourceMonitor(): () => VoiceResourceStats {
    let previousProcess = process.cpuUsage();
    let previousSystem = systemCpuTimes();
    let previousTime = performance.now();

    return () => {
        const now = performance.now();
        const processUsage = process.cpuUsage();
        const systemUsage = systemCpuTimes();
        const elapsedMicroseconds = Math.max(1, (now - previousTime) * 1000);
        const logicalCores = Math.max(1, cpus().length);
        const processMicroseconds =
            processUsage.user -
            previousProcess.user +
            processUsage.system -
            previousProcess.system;
        const systemTotal = systemUsage.total - previousSystem.total;
        const systemIdle = systemUsage.idle - previousSystem.idle;
        const totalMemoryBytes = totalmem();
        const availableMemoryBytes = freemem();
        let systemCpuPercent = 0;
        if (systemTotal > 0) {
            systemCpuPercent = (1 - systemIdle / systemTotal) * 100;
        }
        let systemMemoryPercent = 0;
        if (totalMemoryBytes > 0) {
            systemMemoryPercent =
                ((totalMemoryBytes - availableMemoryBytes) / totalMemoryBytes) *
                100;
        }

        previousProcess = processUsage;
        previousSystem = systemUsage;
        previousTime = now;

        return {
            sampledAt: Date.now(),
            voiceCpuPercent: clamp(
                (processMicroseconds / elapsedMicroseconds / logicalCores) *
                    100,
            ),
            systemCpuPercent: clamp(systemCpuPercent),
            voiceMemoryBytes: process.memoryUsage.rss(),
            totalMemoryBytes,
            availableMemoryBytes,
            systemMemoryPercent: clamp(systemMemoryPercent),
        };
    };
}

function systemCpuTimes(): SystemCpuTimes {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus()) {
        idle += cpu.times.idle;
        total +=
            cpu.times.user +
            cpu.times.nice +
            cpu.times.sys +
            cpu.times.idle +
            cpu.times.irq;
    }
    return { idle, total };
}

function clamp(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(100, Math.max(0, value));
}
