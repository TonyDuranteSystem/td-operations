#!/usr/bin/env ruby
# Generates TDStorage.xcodeproj (host app + Finder extension) — dev job 1992a087. The project file is NOT checked in: run
#   GEM_HOME=~/.gem/ruby/2.6.0 ruby generate_xcodeproj.rb     (gem install xcodeproj --user-install once)
# The shared core (Sources/TDStorageCore) is compiled into BOTH targets, so there is one source of truth and no package linking.
require 'xcodeproj'
require 'fileutils'

ROOT = File.expand_path(__dir__)
Dir.chdir(ROOT)
FileUtils.rm_rf('TDStorage.xcodeproj')
project = Xcodeproj::Project.new('TDStorage.xcodeproj')

# Debug = the dev server on this Mac (http://localhost:3050); Sandbox = the sandbox deployment; Production = the real CRM (the address is a
# setting of the BUILD, not of the code: TD_PRODUCTION_URL=https://host ruby generate_xcodeproj.rb, default https://crm.tonydurante.us).
# Each configuration has its OWN bundle ids and Keychain service/group (suffix), so a sandbox build and a production build can never share
# tokens: a token is also only valid for the database that made it.
prod_url = (ENV['TD_PRODUCTION_URL'] || 'https://crm.tonydurante.us').sub(%r{\A(https?:)//}, '\\1/$()/')
CONFIGS = {
  'Debug'   => { 'TD_SERVER_URL' => 'http:/$()/localhost:3050',            'ID' => 'com.tonydurante.tdstorage.local',   'SUFFIX' => 'local' },
  'Sandbox' => { 'TD_SERVER_URL' => 'https:/$()/td-operations-sandbox.vercel.app', 'ID' => 'com.tonydurante.tdstorage.sandbox', 'SUFFIX' => 'sandbox' },
  'Production' => { 'TD_SERVER_URL' => prod_url, 'ID' => 'com.tonydurante.tdstorage', 'SUFFIX' => 'prod' },
}
project.build_configurations.each { |c| c.build_settings.clear }
project.build_configurations.find { |c| c.name == 'Release' }.name = 'Sandbox'   # the second configuration
project.add_build_configuration('Production', :release)                         # the third, created explicitly (never by renaming)

common = {
  'SWIFT_VERSION' => '5.0', 'MACOSX_DEPLOYMENT_TARGET' => '13.0', 'CODE_SIGN_STYLE' => 'Automatic',
  'ENABLE_HARDENED_RUNTIME' => 'YES', 'GENERATE_INFOPLIST_FILE' => 'NO', 'CURRENT_PROJECT_VERSION' => '1', 'MARKETING_VERSION' => '0.1.0',
  'SDKROOT' => 'macosx', 'CLANG_ENABLE_MODULES' => 'YES', 'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES',
}
project.build_configurations.each do |c|
  c.build_settings.merge!(common)
  c.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = c.name == 'Debug' ? '-Onone' : '-O'
  c.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = c.name == 'Debug' ? 'DEBUG' : ''
end

app = project.new_target(:application, 'TDStorage', :osx, '13.0')
ext = project.new_target(:app_extension, 'TDStorageFileProvider', :osx, '13.0')
[app, ext].each { |t| t.build_configurations.find { |c| c.name == 'Release' }&.name = 'Sandbox'; t.add_build_configuration('Production', :release) }

def group_for(project, path)
  project.main_group.find_subpath(path, true).tap { |g| g.set_source_tree('<group>'); g.set_path(path) }
end
core_group = group_for(project, 'Sources/TDStorageCore')
app_group  = group_for(project, 'App')
ext_group  = group_for(project, 'FileProviderExtension')

core_files = Dir['Sources/TDStorageCore/*.swift'].sort.map { |f| core_group.new_reference(File.basename(f)) }
app_files  = Dir['App/*.swift'].sort.map { |f| app_group.new_reference(File.basename(f)) }
ext_files  = Dir['FileProviderExtension/*.swift'].sort.map { |f| ext_group.new_reference(File.basename(f)) }
app_group.new_reference('Info.plist'); app_group.new_reference('TDStorage.entitlements')
ext_group.new_reference('Info.plist'); ext_group.new_reference('TDStorageFileProvider.entitlements')

app.add_file_references(core_files + app_files)
ext.add_file_references(core_files + ext_files)

{ app => ['App', 'TDStorage', 'TDStorage.entitlements', ''], ext => ['FileProviderExtension', 'TDStorageFileProvider', 'TDStorageFileProvider.entitlements', '.fileprovider'] }.each do |t, (dir, name, ents, idsuffix)|
  t.build_configurations.each do |c|
    cfg = CONFIGS[c.name]
    c.build_settings.merge!(
      'PRODUCT_NAME' => name, 'PRODUCT_BUNDLE_IDENTIFIER' => "#{cfg['ID']}#{idsuffix}",
      'INFOPLIST_FILE' => "#{dir}/Info.plist", 'CODE_SIGN_ENTITLEMENTS' => "#{dir}/#{ents}",
      'TD_SERVER_URL' => cfg['TD_SERVER_URL'],
      'TD_KEYCHAIN_SERVICE' => "com.tonydurante.tdstorage.#{cfg['SUFFIX']}",
      'TD_KEYCHAIN_GROUP' => "$(AppIdentifierPrefix)com.tonydurante.tdstorage.#{cfg['SUFFIX']}.shared",
      'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/../Frameworks', '@executable_path/../../../../Frameworks'],
    )
    c.build_settings['SKIP_INSTALL'] = 'YES' if t == ext
  end
end

# the Finder extension rides inside the app
app.add_dependency(ext)
embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.dst_subfolder_spec = '13' # PlugIns
bf = embed.add_file_reference(ext.product_reference, true)
bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy', 'CodeSignOnCopy'] }

project.save
%w[Debug Sandbox Production].each do |cfg|
  scheme = Xcodeproj::XCScheme.new
  scheme.add_build_target(app)
  scheme.set_launch_target(app)
  scheme.launch_action.build_configuration = cfg
  scheme.save_as(project.path, { 'Debug' => 'TDStorage', 'Sandbox' => 'TDStorage-Sandbox', 'Production' => 'TDStorage-Production' }[cfg], true)
end
puts "generated TDStorage.xcodeproj"
