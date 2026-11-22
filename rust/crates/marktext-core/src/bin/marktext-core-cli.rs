use marktext_core::{extract_outline, parse_blocks, word_count};
use serde::Serialize;
use std::env;
use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunMetrics {
    iterations: usize,
    p50_ms: f64,
    p95_ms: f64,
    mean_ms: f64,
    peak_rss_kb: u64,
}

#[derive(Serialize)]
struct SuccessEnvelope<T: Serialize> {
    component: String,
    engine: &'static str,
    output: T,
    metrics: RunMetrics,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    component: String,
    engine: &'static str,
    error: String,
    code: &'static str,
}

struct CliArgs {
    component: String,
    input: PathBuf,
    iterations: usize,
}

fn parse_args() -> Result<CliArgs, String> {
    let mut args = env::args().skip(1);
    let component = args.next().ok_or_else(|| {
        "Usage: marktext-core-cli <word-count|outline-toc|markdown-blocks> --input <path> [--iterations <N>]"
            .to_string()
    })?;

    let mut input: Option<PathBuf> = None;
    let mut iterations: usize = 100;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" | "-i" => {
                let val = args
                    .next()
                    .ok_or_else(|| "Missing value for --input".to_string())?;
                input = Some(PathBuf::from(val));
            }
            "--iterations" | "-n" => {
                let val = args
                    .next()
                    .ok_or_else(|| "Missing value for --iterations".to_string())?;
                let parsed = val
                    .parse::<usize>()
                    .map_err(|_| format!("Invalid --iterations value '{val}': expected positive integer"))?;
                if parsed == 0 {
                    return Err("--iterations must be at least 1".to_string());
                }
                iterations = parsed;
            }
            other => {
                return Err(format!("Unknown argument '{other}'"));
            }
        }
    }

    let input = input.ok_or_else(|| "Missing required argument --input <path>".to_string())?;

    Ok(CliArgs {
        component,
        input,
        iterations,
    })
}

fn get_peak_rss_kb() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    if rc != 0 {
        return 0;
    }

    #[cfg(target_os = "macos")]
    {
        (usage.ru_maxrss as u64) / 1024
    }
    #[cfg(not(target_os = "macos"))]
    {
        usage.ru_maxrss as u64
    }
}

fn percentile(sorted: &[f64], pct: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((sorted.len() as f64) * pct).ceil() as usize;
    let idx = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[idx]
}

fn round_ms(val: f64) -> f64 {
    (val * 10_000.0).round() / 10_000.0
}

fn benchmark<T, F>(iterations: usize, mut f: F) -> (T, RunMetrics)
where
    F: FnMut() -> T,
{
    let mut samples = Vec::with_capacity(iterations);
    let mut last_output: Option<T> = None;

    for _ in 0..iterations {
        let start = Instant::now();
        let out = black_box(f());
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        samples.push(elapsed_ms);
        last_output = Some(out);
    }

    samples.sort_by(|a, b| a.total_cmp(b));
    let mean_ms = samples.iter().sum::<f64>() / (samples.len() as f64);

    let metrics = RunMetrics {
        iterations,
        p50_ms: round_ms(percentile(&samples, 0.50)),
        p95_ms: round_ms(percentile(&samples, 0.95)),
        mean_ms: round_ms(mean_ms),
        peak_rss_kb: get_peak_rss_kb(),
    };

    (last_output.expect("iterations >= 1"), metrics)
}

fn emit_error(component: &str, code: &'static str, error: String) {
    let payload = ErrorEnvelope {
        component: component.to_string(),
        engine: "rust-core",
        error,
        code,
    };
    let json = serde_json::to_string(&payload).unwrap_or_else(|_| {
        "{\"component\":\"unknown\",\"engine\":\"rust-core\",\"error\":\"serialization error\",\"code\":\"INTERNAL_ERROR\"}".to_string()
    });
    eprintln!("{json}");
}

fn emit_success<T: Serialize>(component: &str, output: T, metrics: RunMetrics) -> ExitCode {
    let envelope = SuccessEnvelope {
        component: component.to_string(),
        engine: "rust-core",
        output,
        metrics,
    };
    match serde_json::to_string_pretty(&envelope) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            emit_error(component, "SERIALIZE_ERROR", err.to_string());
            ExitCode::from(1)
        }
    }
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(parsed) => parsed,
        Err(msg) => {
            emit_error("cli", "CONFIG_ERROR", msg);
            return ExitCode::from(1);
        }
    };

    let markdown = match fs::read_to_string(&args.input) {
        Ok(content) => content,
        Err(err) => {
            emit_error(
                &args.component,
                "IO_ERROR",
                format!("Failed to read '{}': {err}", args.input.display()),
            );
            return ExitCode::from(1);
        }
    };

    match args.component.as_str() {
        "word-count" | "doc-stats" => {
            let (output, metrics) = benchmark(args.iterations, || word_count(&markdown));
            emit_success(&args.component, output, metrics)
        }
        "outline-toc" => {
            let (output, metrics) = benchmark(args.iterations, || extract_outline(&markdown));
            emit_success("outline-toc", output, metrics)
        }
        "markdown-blocks" => match parse_blocks(&markdown) {
            Ok(_) => {
                let (output, metrics) = benchmark(args.iterations, || {
                    parse_blocks(&markdown).expect("parse_blocks succeeded")
                });
                emit_success("markdown-blocks", output, metrics)
            }
            Err(err) => {
                emit_error("markdown-blocks", "NOT_MIGRATED", err);
                ExitCode::from(2)
            }
        },
        other => {
            emit_error(
                other,
                "UNKNOWN_COMPONENT",
                format!("Unknown component '{other}'. Supported: word-count, outline-toc, markdown-blocks"),
            );
            ExitCode::from(1)
        }
    }
}
