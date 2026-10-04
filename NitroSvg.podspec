require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "NitroSvg"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/mohamadnavabi/react-native-nitro-svg.git", :tag => "#{s.version}" }

  s.source_files = [
    "ios/**/*.{swift}",
    "ios/**/*.{m,mm}",
    "cpp/**/*.{hpp,cpp}",
  ]

  # CoreSVG is a system framework resolved at runtime (see ios/NitroSvgDocument.swift),
  # so it is deliberately not linked here.
  s.frameworks = "UIKit", "CoreGraphics"

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'

  load 'nitrogen/generated/ios/NitroSvg+autolinking.rb'
  add_nitrogen_files(s)

  install_modules_dependencies(s)
end
