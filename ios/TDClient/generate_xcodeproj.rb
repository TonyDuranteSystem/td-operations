#!/usr/bin/env ruby
# Generates TDClient.xcodeproj (the CLIENT iPhone app, MyLLC Manager 2.0) — dev job 056a70d0. The project file is NOT checked in; run
#   ruby generate_xcodeproj.rb         (the xcodeproj gem, the same one TD Social's generator uses)
# THIS IS THE SIMULATOR / SANDBOX TEST SHELL: one Debug flavour, the TEST server, alerts through Apple's test address ('development'), the sandbox bundle id
# (the server accepts only its own id: lib/app/environment.ts CLIENT_APP_BUNDLE_IDS). The TestFlight / App Store flavours are Step 5.
#   TD_DEBUG_URL=http://localhost:3051 ruby generate_xcodeproj.rb      (a dev server on this Mac; the simulator reaches the Mac's localhost)
require 'xcodeproj'
require 'fileutils'

ROOT = File.expand_path(__dir__)
Dir.chdir(ROOT)
FileUtils.rm_rf('TDClient.xcodeproj')
project = Xcodeproj::Project.new('TDClient.xcodeproj')

def safe(url)
  url.sub(%r{\A(https?:)//}, '\\1/$()/')
end
test_url = safe(ENV['TD_DEBUG_URL'] || 'https://td-operations-sandbox.vercel.app')

project.build_configurations.each { |c| c.build_settings.clear }
project.build_configurations.find { |c| c.name == 'Release' }.name = 'Sandbox'

common = {
  'SWIFT_VERSION' => '5.0', 'IPHONEOS_DEPLOYMENT_TARGET' => '17.0', 'TARGETED_DEVICE_FAMILY' => '1', 'SDKROOT' => 'iphoneos',
  'GENERATE_INFOPLIST_FILE' => 'NO', 'CURRENT_PROJECT_VERSION' => '1', 'MARKETING_VERSION' => '2.0.0',
  'CLANG_ENABLE_MODULES' => 'YES', 'SUPPORTS_MACCATALYST' => 'NO',
}
project.build_configurations.each do |c|
  c.build_settings.merge!(common)
  c.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = c.name == 'Debug' ? '-Onone' : '-O'
end

app = project.new_target(:application, 'TDClient', :ios, '17.0')
app.build_configurations.find { |c| c.name == 'Release' }&.name = 'Sandbox'

app_group = project.main_group.find_subpath('App', true)
app_group.set_source_tree('<group>'); app_group.set_path('App')
files = Dir['App/*.swift'].sort.map { |f| app_group.new_reference(File.basename(f)) }
app_group.new_reference('Info.plist'); app_group.new_reference('TDClient.entitlements')
app.add_file_references(files)

app.build_configurations.each do |c|
  c.build_settings.merge!(
    'PRODUCT_NAME' => 'TDClient', 'PRODUCT_BUNDLE_IDENTIFIER' => 'com.tonydurante.myllcmanager.sandbox', 'TARGETED_DEVICE_FAMILY' => '1',
    'INFOPLIST_FILE' => 'App/Info.plist', 'CODE_SIGN_ENTITLEMENTS' => 'App/TDClient.entitlements',
    'TD_SERVER_URL' => test_url, 'TD_DISPLAY_NAME' => 'MyLLC (test)', 'TD_APNS_ENV' => 'development', 'TD_APS_ENVIRONMENT' => 'development',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks'],
  )
end

project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.set_launch_target(app)
scheme.launch_action.build_configuration = 'Debug'
scheme.save_as(project.path, 'TDClient', true)
puts 'generated TDClient.xcodeproj'
