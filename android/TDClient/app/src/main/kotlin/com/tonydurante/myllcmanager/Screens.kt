package com.tonydurante.myllcmanager

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Draw
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tonydurante.myllcmanager.core.BarRules
import com.tonydurante.myllcmanager.core.MeOutcome
import com.tonydurante.myllcmanager.core.Msg

private val BadgeRed = Color(0xFFD32F2F)

private fun iconFor(key: String): ImageVector = when (key) {
    "nav.overview" -> Icons.Outlined.Home
    "nav.chat" -> Icons.Outlined.ChatBubbleOutline
    "nav.documents" -> Icons.Outlined.Folder
    "nav.invoices" -> Icons.Outlined.Description
    "nav.tdBilling" -> Icons.Outlined.CreditCard
    "nav.signDocuments" -> Icons.Outlined.Draw
    else -> Icons.Outlined.Circle
}

/** The small red number on a bar button or a Menu line. */
@Composable
private fun CountBadge(count: Int, modifier: Modifier = Modifier, textSize: Int = 10) {
    Box(
        modifier = modifier.clip(RoundedCornerShape(50)).background(BadgeRed).padding(horizontal = 5.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(count.toString(), color = Color.White, fontSize = textSize.sp, fontWeight = FontWeight.Bold)
    }
}

/** The bottom bar, drawn from the server's answer: the buttons the person chose (Chat is always one) with their waiting numbers. */
@Composable
fun BottomBar(me: Me, vm: ClientViewModel) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
        HorizontalDivider(color = Color(0x1F000000))
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp).navigationBarsPadding()) {
            for (key in me.bar) {
                val item = me.items.firstOrNull { it.key == key } ?: continue
                val active = BarRules.isActive(item.path, vm.currentPath, vm.currentTab)
                val tint = if (active) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
                Column(
                    Modifier.weight(1f).clickable { vm.open(item.path) }.testTag("bar-$key"),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box {
                        Icon(iconFor(key), contentDescription = null, tint = tint, modifier = Modifier.size(24.dp))
                        if (item.badge > 0) CountBadge(item.badge, Modifier.align(Alignment.TopEnd).offset(x = 10.dp, y = (-6).dp))
                    }
                    Spacer(Modifier.height(2.dp))
                    Text(
                        item.label,
                        fontSize = 10.sp,
                        fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                        color = tint,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 2.dp),
                    )
                }
            }
        }
    }
}

/** The Menu: every entry the person can open (with its waiting number), and Sign out. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MenuSheet(vm: ClientViewModel) {
    ModalBottomSheet(onDismissRequest = { vm.menuOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        // the sheet is a window of its own: the test names (resource ids) are switched on again here so a test can find its lines
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp).semantics { testTagsAsResourceId = true }.testTag("menu-sheet")) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text(AppConfig.say(Msg.MENU_TITLE), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                TextButton(onClick = { vm.menuOpen = false }) { Text(AppConfig.say(Msg.CLOSE)) }
            }
            val me = vm.me
            // the list scrolls; Sign out stays pinned below it, so it is always in sight (also with many entries on a small phone)
            LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false)) {
                if (me != null) {
                    items(me.items, key = { it.key }) { item ->
                        Row(
                            Modifier.fillMaxWidth().clickable { vm.open(item.path) }.padding(horizontal = 20.dp, vertical = 14.dp).testTag("menu-${item.key}"),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(item.label, fontSize = 17.sp)
                            if (item.badge > 0) CountBadge(item.badge, textSize = 12)
                        }
                        HorizontalDivider(color = Color(0x14000000), modifier = Modifier.padding(horizontal = 20.dp))
                    }
                } else {
                    item {
                        Text(
                            if (vm.meOutcome == null || vm.meOutcome == MeOutcome.SIGNED_OUT) AppConfig.say(Msg.SIGN_IN_FIRST) else AppConfig.say(Msg.MENU_UNAVAILABLE),
                            modifier = Modifier.padding(20.dp),
                        )
                    }
                }
            }
            // Sign out is always there while somebody is signed in, also when the server cannot answer (the app switched off, a fault)
            if (vm.meOutcome != MeOutcome.SIGNED_OUT) {
                Text(
                    AppConfig.say(Msg.SIGN_OUT),
                    color = BadgeRed,
                    fontSize = 17.sp,
                    modifier = Modifier.fillMaxWidth().clickable { vm.signOut() }.padding(horizontal = 20.dp, vertical = 16.dp).testTag("sign-out"),
                )
            }
        }
    }
    // the server could not be told to forget this phone (no connection ...): the person is still signed in and is told so
    if (vm.signOutFailed) {
        AlertDialog(
            onDismissRequest = { vm.signOutFailed = false },
            confirmButton = { TextButton(onClick = { vm.signOutFailed = false }) { Text(AppConfig.say(Msg.OK)) } },
            text = { Text(AppConfig.say(Msg.SIGN_OUT_FAILED)) },
        )
    }
}

/** The page could not be loaded (no connection ...): a plain message and a button, instead of a blank screen. */
@Composable
fun LoadFailedView(vm: ClientViewModel) {
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface).padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Outlined.WifiOff, contentDescription = null, modifier = Modifier.size(40.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(14.dp))
        Text(AppConfig.say(Msg.COULDNT_LOAD), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Text(AppConfig.say(Msg.NO_CONNECTION), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Spacer(Modifier.height(16.dp))
        Button(onClick = { vm.retry() }, modifier = Modifier.testTag("retry")) { Text(AppConfig.say(Msg.TRY_AGAIN)) }
    }
}
