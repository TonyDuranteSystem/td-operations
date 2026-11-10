#!/usr/bin/env ruby
# Generates TDClient.xcodeproj (the CLIENT iPhone app, MyLLC Manager 2.0) — dev job 056a70d0, Step 5. The project file is NOT checked in; run
#   ruby generate_xcodeproj.rb         (the xcodeproj gem, the same one TD Social's generator uses)
# The shared core (Sources/TDClientCore) is compiled INTO the app target, so there is one source of truth and no package linking.
#
# Three flavours (like TD Social):
#   Debug      = the TEST server, runs from Xcode / the simulator, alerts through Apple's test address ('development'). A dev server on this Mac:
#                TD_DEBUG_URL=http://localhost:3051 ruby generate_xcodeproj.rb   (the simulator reaches the Mac's localhost)
#   Sandbox    = the TEST server, built to go to TestFlight, alerts through Apple's live address ('production' = what TestFlight uses)
#   Production = the REAL portal (default https://portal.tonydurante.us; override TD_PRODUCTION_URL), TestFlight / App Store
# Each flavour has its own bundle id (the server accepts only its own: lib/app/environment.ts CLIENT_APP_BUNDLE_IDS), so a test build can never
# register a phone on production. The Production flavour is an UPDATE of the live App Store app "MyLLC Manager" (Apple ID 6749905082, bundle
# com.tonydurante.myllcmanager, live version 1.3 / build 6 on 10 Nov 2026): version 2.0.0, build numbers continue after 6 (TD_BUILD, default 7).
#   TD_BUILD=8 TD_VERSION=2.0.0 ruby generate_xcodeproj.rb
require 'xcodeproj'
require 'fileutils'

ROOT = File.expand_path(__dir__)
Dir.chdir(ROOT)
FileUtils.rm_rf('TDClient.xcodeproj')
project = Xcodeproj::Project.new('TDClient.xcodeproj')

# '//' inside a build setting can be read as a comment by some tools: the same $() trick TD Social's generator uses
def safe(url)
  url.sub(%r{\A(https?:)//}, '\\1/$()/')
end
test_url = safe(ENV['TD_DEBUG_URL'] || 'https://td-operations-sandbox.vercel.app')
sandbox_url = safe(ENV['TD_SANDBOX_URL'] || 'https://td-operations-sandbox.vercel.app')
prod_url = safe(ENV['TD_PRODUCTION_URL'] || 'https://portal.tonydurante.us')
SANDBOX_ID = 'com.tonydurante.myllcmanager.sandbox'
PROD_ID = 'com.tonydurante.myllcmanager'

CONFIGS = {
  'Debug'      => { 'URL' => test_url,    'ID' => SANDBOX_ID, 'NAME' => 'MyLLC (test)',    'APNS' => 'development' },
  'Sandbox'    => { 'URL' => sandbox_url, 'ID' => SANDBOX_ID, 'NAME' => 'MyLLC (sandbox)', 'APNS' => 'production' },
  'Production' => { 'URL' => prod_url,    'ID' => PROD_ID,    'NAME' => 'MyLLC Manager',   'APNS' => 'production' },
}

project.build_configurations.each { |c| c.build_settings.clear }
project.build_configurations.find { |c| c.name == 'Release' }.name = 'Sandbox'
project.add_build_configuration('Production', :release)

common = {
  'SWIFT_VERSION' => '5.0', 'IPHONEOS_DEPLOYMENT_TARGET' => '17.0', 'TARGETED_DEVICE_FAMILY' => '1', 'SDKROOT' => 'iphoneos',
  'CODE_SIGN_STYLE' => 'Automatic', 'DEVELOPMENT_TEAM' => (ENV['TD_TEAM'] || 'LMKMUC5864'),
  'GENERATE_INFOPLIST_FILE' => 'NO', 'CURRENT_PROJECT_VERSION' => (ENV['TD_BUILD'] || '7'), 'MARKETING_VERSION' => (ENV['TD_VERSION'] || '2.0.0'),
  'CLANG_ENABLE_MODULES' => 'YES', 'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES', 'ASSETCATALOG_COMPILER_APPICON_NAME' => 'AppIcon',
  'SUPPORTS_MACCATALYST' => 'NO', 'SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD' => 'NO',
}
project.build_configurations.each do |c|
  c.build_settings.merge!(common)
  c.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = c.name == 'Debug' ? '-Onone' : '-O'
  c.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = c.name == 'Debug' ? 'DEBUG' : ''
end

app = project.new_target(:application, 'TDClient', :ios, '17.0')
app.build_configurations.find { |c| c.name == 'Release' }&.name = 'Sandbox'
app.add_build_configuration('Production', :release)

def group_for(project, path)
  project.main_group.find_subpath(path, true).tap { |g| g.set_source_tree('<group>'); g.set_path(path) }
end
core_group = group_for(project, 'Sources/TDClientCore')
app_group  = group_for(project, 'App')

core_files = Dir['Sources/TDClientCore/*.swift'].sort.map { |f| core_group.new_reference(File.basename(f)) }
app_files  = Dir['App/*.swift'].sort.map { |f| app_group.new_reference(File.basename(f)) }
app_group.new_reference('Info.plist'); app_group.new_reference('TDClient.entitlements')
assets = app_group.new_reference('Assets.xcassets')
assets.last_known_file_type = 'folder.assetcatalog'
# Apple's privacy manifest (App Store submission): copied to the root of the app, where Apple looks for it
privacy = app_group.new_reference('PrivacyInfo.xcprivacy')
privacy.last_known_file_type = 'text.xml'

app.add_file_references(core_files + app_files)
app.resources_build_phase.add_file_reference(assets, true)
app.resources_build_phase.add_file_reference(privacy, true)

app.build_configurations.each do |c|
  cfg = CONFIGS[c.name]
  c.build_settings.merge!(
    'PRODUCT_NAME' => 'TDClient', 'PRODUCT_BUNDLE_IDENTIFIER' => cfg['ID'], 'TARGETED_DEVICE_FAMILY' => '1',   # iPhone only
    'INFOPLIST_FILE' => 'App/Info.plist', 'CODE_SIGN_ENTITLEMENTS' => 'App/TDClient.entitlements',
    'TD_SERVER_URL' => cfg['URL'], 'TD_DISPLAY_NAME' => cfg['NAME'], 'TD_APNS_ENV' => cfg['APNS'],
    'TD_APS_ENVIRONMENT' => cfg['APNS'] == 'development' ? 'development' : 'production',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks'],
  )
end

project.save
{ 'Debug' => 'TDClient', 'Sandbox' => 'TDClient-Sandbox', 'Production' => 'TDClient-Production' }.each do |cfg, name|
  scheme = Xcodeproj::XCScheme.new
  scheme.add_build_target(app)
  scheme.set_launch_target(app)
  scheme.launch_action.build_configuration = cfg
  scheme.archive_action.build_configuration = cfg
  scheme.save_as(project.path, name, true)
end
puts 'generated TDClient.xcodeproj'
