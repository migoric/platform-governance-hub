//! 入口：开窗口 / 出结构快照 / 自检。
//!
//! 参数解析手写：M0 只有五个开关，引 clap 不值得（sidecar 那边零依赖的理由一样）。

use std::path::PathBuf;
use std::process::ExitCode;

use hub::app::{render, window};
use hub::features::{shell, View, ViewCtx};
use hub::state::{store as store_dir, Store};
use hub::ui::{Appearance, Palette};

const USAGE: &str = "用法：hub [选项]

  （无参数）                 打开窗口，读 $PGH_HOME 或 ~/.pgh/
  --render <目录>           出 8 份结构快照（读 fixtures/）
  --check-baseline          与 fixtures/structure/ 基准逐文件比较，不一致退出码 1
  --appearance <light|dark> 配色（默认 light）
  --fixtures <目录>         覆盖 fixture 目录（默认 GovernanceHub/fixtures）
  --self-check              不开窗口，打印数据源与计数
  --help                    本说明";

#[derive(Debug)]
struct Options {
    render: Option<PathBuf>,
    check_baseline: bool,
    appearance: Appearance,
    fixtures: PathBuf,
    self_check: bool,
}

fn main() -> ExitCode {
    match parse(std::env::args().skip(1).collect()) {
        Err(message) => {
            eprintln!("{message}\n\n{USAGE}");
            ExitCode::from(2)
        }
        Ok(None) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Some(options)) => run(options),
    }
}

fn parse(argv: Vec<String>) -> Result<Option<Options>, String> {
    let mut options = Options {
        render: None,
        check_baseline: false,
        appearance: Appearance::Light,
        fixtures: store_dir::fixtures_dir(),
        self_check: false,
    };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--help" | "-h" => return Ok(None),
            "--render" => {
                options.render = Some(PathBuf::from(value(&argv, i, "--render")?));
                i += 2;
            }
            "--fixtures" => {
                options.fixtures = PathBuf::from(value(&argv, i, "--fixtures")?);
                i += 2;
            }
            "--appearance" => {
                let raw = value(&argv, i, "--appearance")?;
                options.appearance = Appearance::parse(&raw);
                i += 2;
            }
            "--check-baseline" => {
                options.check_baseline = true;
                i += 1;
            }
            "--self-check" => {
                options.self_check = true;
                i += 1;
            }
            other => return Err(format!("未知参数：{other}")),
        }
    }
    Ok(Some(options))
}

fn value(argv: &[String], index: usize, flag: &str) -> Result<String, String> {
    argv.get(index + 1)
        .filter(|v| !v.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("{flag} 需要一个值"))
}

fn run(options: Options) -> ExitCode {
    if let Some(dir) = &options.render {
        return render_to(dir, &options);
    }
    if options.check_baseline {
        return check_baseline(&options);
    }
    let store = Store::from_fixtures(&options.fixtures);
    if options.self_check {
        return self_check(&store, options.appearance);
    }
    // 真窗口读本机数据；fixture 只给 --render 与 UI 测试用（AGENTS.md §3.7）
    let store = Store::from_home();
    let palette = Palette::for_appearance(options.appearance);
    let tree = shell::build(View::Dashboard, &ViewCtx::new(&store, palette));
    window::run(tree);
    ExitCode::SUCCESS
}

fn render_to(dir: &PathBuf, options: &Options) -> ExitCode {
    let store = Store::from_fixtures(&options.fixtures);
    match render::render_all(&store, dir, options.appearance) {
        Ok(rendered) => {
            for item in &rendered {
                println!(
                    "✔ {}  {} 节点 / {} 条文本",
                    item.path.display(),
                    item.nodes,
                    item.texts
                );
            }
            println!("✔ 共 {} 份结构快照（{}）", rendered.len(), options.appearance.slug());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("✘ 出图失败：{e}");
            ExitCode::FAILURE
        }
    }
}

fn check_baseline(options: &Options) -> ExitCode {
    let store = Store::from_fixtures(&options.fixtures);
    let baseline = render::baseline_dir();
    match render::compare_with(&store, &baseline, options.appearance) {
        Ok(diffs) if diffs.is_empty() => {
            println!("✔ 结构快照与基准一致（{}）", baseline.display());
            ExitCode::SUCCESS
        }
        Ok(diffs) => {
            eprintln!("✘ 结构快照与基准不一致：");
            for diff in &diffs {
                eprintln!("  · {diff}");
            }
            eprintln!("如果是想要的变化：cargo run -p hub -- --render fixtures/structure");
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("✘ 比对失败：{e}");
            ExitCode::FAILURE
        }
    }
}

fn self_check(store: &Store, appearance: Appearance) -> ExitCode {
    println!("数据源：{}", store.provenance_line());
    println!("快照：{}", present(store.has_snapshot()));
    println!("任务：{}", present(store.has_tasks()));
    println!("配色：{}", appearance.slug());
    println!("视图数：{}", View::all().len());
    if store.load_error.is_some() {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn present(value: bool) -> &'static str {
    if value { "有" } else { "无（走空状态）" }
}
