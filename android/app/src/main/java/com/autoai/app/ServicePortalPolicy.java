package com.autoai.app;

import java.net.IDN;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class ServicePortalPolicy {
    private ServicePortalPolicy() {}

    static boolean isAllowed(String destination, String officialOrigin) {
        try {
            URI target = new URI(destination);
            URI origin = new URI(officialOrigin);
            return secureOrigin(target) && secureOrigin(origin)
                && normalizedHost(target).equals(normalizedHost(origin))
                && effectivePort(target) == effectivePort(origin)
                && target.getRawUserInfo() == null;
        } catch (IllegalArgumentException | URISyntaxException error) {
            return false;
        }
    }

    private static boolean secureOrigin(URI value) {
        return "https".equalsIgnoreCase(value.getScheme())
            && value.getHost() != null
            && !value.getHost().isBlank()
            && effectivePort(value) == 443;
    }

    private static String normalizedHost(URI value) {
        return IDN.toASCII(value.getHost()).toLowerCase(Locale.ROOT);
    }

    private static int effectivePort(URI value) {
        return value.getPort() < 0 ? 443 : value.getPort();
    }
}
