#!/usr/bin/env ruby
# Generates TDSocial.xcodeproj (the iPhone app) — dev job 2072bc3e, Step 3. The project file is NOT checked in; run
#   ruby generate_xcodeproj.rb            (the xcodeproj gem is the same one the Mac app's generator uses)
# The shared core (Sources/TDSocialCore) is compiled INTO the app target, so there is one source of truth and no package linking.
#
# Three flavours (like the Mac app):
#   Debug      = the TEST server, runs from Xcode / the simulator, alerts through Apple's test address ('development'). The address can be a private
#                sandbox build for a test: TD_DEBUG_URL=https://td-operations-sandbox-xxxx-....vercel.app ruby generate_xcodeproj.rb
#   Sandbox    = the TEST server, built to go to TestFlight, alerts through Apple's live address ('production' = what TestFlight uses)
#   Production = the REAL CRM (default https://crm.tonydurante.us; override TD_PRODUCTION_URL), TestFlight / App Store
# Each flavour has its own bundle id (sandbox and production can never share a phone registration: the server accepts only its own).
require 'xcodeproj'
require 'fileutils'

ROOT = File.expand_path(__dir__)
Dir.chdir(ROOT)
FileUtils.rm_rf('TDSocial.xcodeproj')
project = Xcodeproj::Project.new('TDSocial.xcodeproj')

# '//' inside a build setting can be read as a comment by some tools: the same $() trick the Mac app's generator uses
def safe(url)
  url.sub(%r{\A(https?:)//}, '\\1/$()/')
end
test_url = safe(ENV['TD_DEBUG_URL'] || 'https://td-operations-sandbox.vercel.app')
sandbox_url = safe(ENV['TD_SANDBOX_URL'] || 'https://td-operations-sandbox.vercel.app')
prod_url = safe(ENV['TD_PRODUCTION_URL'] || 'https://crm.tonydurante.us')
SANDBOX_ID = 'com.tonydurante.tdsocial.sandbox'
PROD_ID = 'com.tonydurante.tdsocial'

CONFIGS = {
  'Debug'      => { 'URL' => test_url,    'ID' => SANDBOX_ID, 'NAME' => 'TD Social (test)',    'SERVER' => 'Test server (debug)', 'APNS' => 'development' },
  'Sandbox'    => { 'URL' => sandbox_url, 'ID' => SANDBOX_ID, 'NAME' => 'TD Social (sandbox)', 'SERVER' => 'Test server',         'APNS' => 'production' },
  'Production' => { 'URL' => prod_url,    'ID' => PROD_ID,    'NAME' => 'TD Social',           'SERVER' => 'Live',                'APNS' => 'production' },
}

project.build_configurations.each { |c| c.build_settings.clear }
project.build_configurations.find { |c| c.name == 'Release' }.name = 'Sandbox'
project.add_build_configuration('Production', :release)

common = {
  'SWIFT_VERSION' => '5.0', 'IPHONEOS_DEPLOYMENT_TARGET' => '17.0', 'TARGETED_DEVICE_FAMILY' => '1', 'SDKROOT' => 'iphoneos',
  'CODE_SIGN_STYLE' => 'Automatic', 'DEVELOPMENT_TEAM' => (ENV['TD_TEAM'] || 'LMKMUC5864'),
  'GENERATE_INFOPLIST_FILE' => 'NO', 'CURRENT_PROJECT_VERSION' => (ENV['TD_BUILD'] || '1'), 'MARKETING_VERSION' => (ENV['TD_VERSION'] || '0.1.0'),
  'CLANG_ENABLE_MODULES' => 'YES', 'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES', 'ASSETCATALOG_COMPILER_APPICON_NAME' => 'AppIcon',
  'SUPPORTS_MACCATALYST' => 'NO', 'SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD' => 'NO',
}
project.build_configurations.each do |c|
  c.build_settings.merge!(common)
  c.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = c.name == 'Debug' ? '-Onone' : '-O'
  c.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = c.name == 'Debug' ? 'DEBUG' : ''
end

app = project.new_target(:application, 'TDSocial', :ios, '17.0')
app.build_configurations.find { |c| c.name == 'Release' }&.name = 'Sandbox'
app.add_build_configuration('Production', :release)

def group_for(project, path)
  project.main_group.find_subpath(path, true).tap { |g| g.set_source_tree('<group>'); g.set_path(path) }
end
core_group = group_for(project, 'Sources/TDSocialCore')
app_group  = group_for(project, 'App')

core_files = Dir['Sources/TDSocialCore/*.swift'].sort.map { |f| core_group.new_reference(File.basename(f)) }
app_files  = Dir['App/*.swift'].sort.map { |f| app_group.new_reference(File.basename(f)) }
app_group.new_reference('Info.plist'); app_group.new_reference('TDSocial.entitlements')
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
    'PRODUCT_NAME' => 'TDSocial', 'PRODUCT_BUNDLE_IDENTIFIER' => cfg['ID'], 'TARGETED_DEVICE_FAMILY' => '1',   # iPhone only (the target's own default would say iPhone + iPad, which Apple then validates as iPad multitasking)
    'INFOPLIST_FILE' => 'App/Info.plist', 'CODE_SIGN_ENTITLEMENTS' => 'App/TDSocial.entitlements',
    'TD_SERVER_URL' => cfg['URL'], 'TD_SERVER_NAME' => cfg['SERVER'], 'TD_DISPLAY_NAME' => cfg['NAME'], 'TD_APNS_ENV' => cfg['APNS'],
    'TD_APS_ENVIRONMENT' => cfg['APNS'] == 'development' ? 'development' : 'production',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks'],
  )
end

project.save
{ 'Debug' => 'TDSocial', 'Sandbox' => 'TDSocial-Sandbox', 'Production' => 'TDSocial-Production' }.each do |cfg, name|
  scheme = Xcodeproj::XCScheme.new
  scheme.add_build_target(app)
  scheme.set_launch_target(app)
  scheme.launch_action.build_configuration = cfg
  scheme.archive_action.build_configuration = cfg
  scheme.save_as(project.path, name, true)
end
puts "generated TDSocial.xcodeproj"
