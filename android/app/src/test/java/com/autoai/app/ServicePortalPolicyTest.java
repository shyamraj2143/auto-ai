package com.autoai.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServicePortalPolicyTest {
    @Test public void acceptsPathOnExactVerifiedHttpsOrigin() {
        assertTrue(ServicePortalPolicy.isAllowed(
            "https://serviceonline.bihar.gov.in/renderApplicationForm.do?serviceId=4640012",
            "https://serviceonline.bihar.gov.in"
        ));
    }

    @Test public void blocksLookalikesDowngradesCredentialsAndPorts() {
        assertFalse(ServicePortalPolicy.isAllowed("https://serviceonline.bihar.gov.in.evil.test/app", "https://serviceonline.bihar.gov.in"));
        assertFalse(ServicePortalPolicy.isAllowed("http://serviceonline.bihar.gov.in/app", "https://serviceonline.bihar.gov.in"));
        assertFalse(ServicePortalPolicy.isAllowed("https://user@serviceonline.bihar.gov.in/app", "https://serviceonline.bihar.gov.in"));
        assertFalse(ServicePortalPolicy.isAllowed("https://serviceonline.bihar.gov.in:8443/app", "https://serviceonline.bihar.gov.in"));
    }
}
