import { chmod, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { exec } from '../lib/childProcess.js';
import { ensureDir, ensureDirs } from '../lib/fileUtils.js';
import { writeAgentInstructions } from '../lib/agentInstructionsFile.js';
import {
  XCODE_TEAM_ID, XCODE_BUNDLE_PREFIX, XCODE_ENV_EXAMPLE,
  generateDeployScript, toBundleId, toTargetName,
} from '../services/xcodeScripts.js';

const execAsync = promisify(exec);

export async function scaffoldIOS(repoPath, name, dirName, addStep) {
  const bundleId = toBundleId(name);
  const teamId = XCODE_TEAM_ID;
  const targetName = toTargetName(name);

  // project.yml (XcodeGen source of truth)
  await writeFile(join(repoPath, 'project.yml'), `name: ${targetName}
options:
  bundleIdPrefix: ${XCODE_BUNDLE_PREFIX}
  deploymentTarget:
    iOS: "17.0"
  xcodeVersion: "16.0"
  generateEmptyDirectories: true

settings:
  base:
    DEVELOPMENT_TEAM: ${teamId}
    MARKETING_VERSION: "1.0.0"
    CURRENT_PROJECT_VERSION: 1
    SWIFT_VERSION: "5.9"

targets:
  ${targetName}:
    type: application
    platform: iOS
    sources:
      - path: ${targetName}
        excludes:
          - Preview Content/PreviewAssets.xcassets
      - path: ${targetName}/Preview Content/PreviewAssets.xcassets
        buildPhase: none
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}
        INFOPLIST_FILE: ${targetName}/Info.plist
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        INFOPLIST_KEY_ITSAppUsesNonExemptEncryption: NO
        INFOPLIST_KEY_UISupportedInterfaceOrientations: "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
        INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad: "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
        INFOPLIST_KEY_UILaunchScreen_Generation: true
        DEVELOPMENT_ASSET_PATHS: "\\"${targetName}/Preview Content\\""
        GENERATE_INFOPLIST_FILE: true
    scheme:
      testTargets:
        - ${targetName}Tests

  ${targetName}Tests:
    type: bundle.unit-test
    platform: iOS
    sources:
      - path: ${targetName}Tests
    dependencies:
      - target: ${targetName}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}Tests
        GENERATE_INFOPLIST_FILE: true
        TEST_HOST: "$(BUILT_PRODUCTS_DIR)/${targetName}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/${targetName}"
        BUNDLE_LOADER: "$(TEST_HOST)"
`);

  // Create source directories
  const srcDir = join(repoPath, targetName);
  const previewDir = join(srcDir, 'Preview Content');
  const testsDir = join(repoPath, `${targetName}Tests`);

  await ensureDirs([srcDir, previewDir, testsDir]);

  // Info.plist
  await writeFile(join(srcDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>This app needs microphone access for audio recording.</string>
</dict>
</plist>
`);

  // App entry point
  await writeFile(join(srcDir, `${targetName}App.swift`), `import SwiftUI

@main
struct ${targetName}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`);

  // ContentView
  await writeFile(join(srcDir, 'ContentView.swift'), `import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "app.fill")
                    .font(.system(size: 60))
                    .foregroundStyle(.blue)

                Text("${name}")
                    .font(.largeTitle)
                    .fontWeight(.bold)

                Text("Built with PortOS")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .navigationTitle("${name}")
        }
    }
}
`);

  // Assets.xcassets
  await ensureDir(join(srcDir, 'Assets.xcassets', 'AppIcon.appiconset'));
  await writeFile(join(srcDir, 'Assets.xcassets', 'Contents.json'), '{"info":{"version":1,"author":"xcode"}}');
  await writeFile(join(srcDir, 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'), `{
  "images": [{"idiom": "universal", "platform": "ios", "size": "1024x1024"}],
  "info": {"version": 1, "author": "xcode"}
}`);

  // Preview Assets
  await ensureDir(join(previewDir, 'PreviewAssets.xcassets'));
  await writeFile(join(previewDir, 'PreviewAssets.xcassets', 'Contents.json'), '{"info":{"version":1,"author":"xcode"}}');

  // Unit test
  await writeFile(join(testsDir, `${targetName}Tests.swift`), `import XCTest
@testable import ${targetName}

final class ${targetName}Tests: XCTestCase {
    func testAppLaunches() {
        XCTAssertTrue(true, "App scaffold is functional")
    }
}
`);

  // Shared Xcode deployment assets
  await writeFile(join(repoPath, '.env.example'), XCODE_ENV_EXAMPLE);
  const deployPath = join(repoPath, 'deploy.sh');
  await writeFile(deployPath, generateDeployScript(targetName, bundleId));
  if (process.platform !== 'win32') await chmod(deployPath, 0o755);

  // AGENTS.md (+ the Claude Code bridge)
  await writeAgentInstructions(repoPath, `# ${name}

iOS native app built with SwiftUI and XcodeGen.

## Tech Stack

- **SwiftUI** + **SwiftData** (iOS 17.0+)
- **XcodeGen** for project generation (\`project.yml\` is the source of truth, not the \`.xcodeproj\`)
- Bundle ID: \`${bundleId}\`, Team: \`${teamId}\`

## Build Commands

\`\`\`bash
# Generate Xcode project (required after changing project.yml)
xcodegen generate

# Build
xcodebuild build -project ${targetName}.xcodeproj -scheme ${targetName} \\
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO

# Run tests
xcodebuild test -project ${targetName}.xcodeproj -scheme ${targetName} \\
  -only-testing:${targetName}Tests \\
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
\`\`\`

## TestFlight Deployment

Local deploy via \`./deploy.sh\`:

\`\`\`bash
./deploy.sh              # full: tests + archive + upload
./deploy.sh --skip-tests # skip tests for faster iteration
\`\`\`

Requires \`.env\` file with App Store Connect API credentials (see \`.env.example\`).
`);

  addStep('Create iOS project', 'done');

  // Run xcodegen if available
  const { stderr: xgenErr } = await execAsync('xcodegen generate', { cwd: repoPath })
    .catch(err => ({ stderr: err.message }));

  if (xgenErr && !xgenErr.includes('Created project')) {
    addStep('Generate Xcode project', 'error', xgenErr);
  } else {
    addStep('Generate Xcode project', 'done');
  }
}
