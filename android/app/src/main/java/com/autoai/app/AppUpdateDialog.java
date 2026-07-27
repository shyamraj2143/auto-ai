package com.autoai.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.Locale;

/** Lifecycle-safe renderer; all durable state remains in AppUpdateCoordinator. */
public final class AppUpdateDialog implements AppUpdateCoordinator.Listener {
    private final Activity activity; private final AppUpdateCoordinator coordinator;
    private AlertDialog dialog; private TextView title,version,details,status,progressText; private ProgressBar progress; private Button primary,secondary;
    public AppUpdateDialog(Activity activity){this.activity=activity;coordinator=AppUpdateCoordinator.get(activity);}
    public void start(){coordinator.addListener(this);}
    public void stop(){coordinator.removeListener(this);if(dialog!=null){dialog.dismiss();dialog=null;}}
    @Override public void onUpdateChanged(AppUpdateCoordinator.Snapshot s){activity.runOnUiThread(()->render(s));}

    private void render(AppUpdateCoordinator.Snapshot s){
        if(activity.isFinishing()||(Build.VERSION.SDK_INT>=17&&activity.isDestroyed()))return;
        boolean visible=s.metadata!=null&&s.metadata.versionCode>BuildConfig.VERSION_CODE&&s.state!=AppUpdateCoordinator.State.IDLE&&s.state!=AppUpdateCoordinator.State.INSTALLED;
        if(!visible){if(dialog!=null){dialog.dismiss();dialog=null;}return;}
        if(dialog==null)create();
        AppUpdateCoordinator.Metadata m=s.metadata;
        title.setText(m.mandatory?"Update Required":"New AutoAI Update");
        version.setText("v"+BuildConfig.VERSION_NAME+"  →  v"+m.versionName+"  •  "+formatSize(m.fileSize));
        details.setText((m.changelog==null||m.changelog.trim().isEmpty()?"Performance, stability and security improvements.":m.changelog.trim())+"\n\n✓ Secure build verified after download"+(m.releaseDate.isEmpty()?"":"\nReleased "+m.releaseDate));
        status.setText(TextUtils.isEmpty(s.message)?label(s.state):s.message);
        boolean downloading=s.state==AppUpdateCoordinator.State.DOWNLOADING||s.state==AppUpdateCoordinator.State.VERIFYING||s.state==AppUpdateCoordinator.State.QUEUED||s.state==AppUpdateCoordinator.State.PAUSED_WAITING_FOR_NETWORK;
        progress.setVisibility(downloading?View.VISIBLE:View.GONE);progressText.setVisibility(downloading?View.VISIBLE:View.GONE);
        if(downloading&&s.totalBytes>0){progress.setIndeterminate(false);int pct=(int)Math.min(100,s.downloadedBytes*100/s.totalBytes);progress.setProgress(pct);progressText.setText(formatSize(s.downloadedBytes)+" / "+formatSize(s.totalBytes)+"  •  "+pct+"%");}
        else if(downloading){progress.setIndeterminate(true);progressText.setText(s.downloadedBytes>0?formatSize(s.downloadedBytes):"");}
        primary.setEnabled(!downloading); primary.setText(action(s.state)); primary.setOnClickListener(v->primary(s));
        boolean showSecondary=(!m.mandatory&&(s.state==AppUpdateCoordinator.State.AVAILABLE||s.state==AppUpdateCoordinator.State.FAILED||downloading))
            || (m.mandatory && s.state==AppUpdateCoordinator.State.FAILED);
        secondary.setVisibility(showSecondary?View.VISIBLE:View.GONE);secondary.setText(downloading?"Cancel":"Later");secondary.setOnClickListener(v->{if(downloading)coordinator.cancelOptional();else coordinator.dismissOptional();});
        if(m.mandatory&&s.state==AppUpdateCoordinator.State.FAILED){secondary.setText("Exit App");secondary.setOnClickListener(v->activity.finishAndRemoveTask());}
        dialog.setCancelable(!m.mandatory);dialog.setCanceledOnTouchOutside(!m.mandatory);
        if(!dialog.isShowing())dialog.show();
    }

    private void create(){
        LinearLayout box=new LinearLayout(activity);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(22),dp(20),dp(22),dp(18));
        GradientDrawable bg=new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{Color.rgb(35,20,72),Color.rgb(12,31,63),Color.rgb(8,56,67)});bg.setCornerRadius(dp(24));bg.setStroke(dp(1),Color.rgb(116,85,255));box.setBackground(bg);
        TextView icon=text("✦",30,Color.rgb(93,225,255)); icon.setGravity(Gravity.CENTER);box.addView(icon);
        title=text("",22,Color.WHITE);title.setGravity(Gravity.CENTER);title.setPadding(0,dp(6),0,dp(4));box.addView(title);
        version=text("",14,Color.rgb(145,220,255));version.setGravity(Gravity.CENTER);box.addView(version);
        details=text("",14,Color.rgb(224,225,242));details.setMaxLines(7);details.setEllipsize(TextUtils.TruncateAt.END);details.setPadding(0,dp(16),0,dp(12));box.addView(details);
        status=text("",14,Color.rgb(86,232,187));box.addView(status);
        progress=new ProgressBar(activity,null,android.R.attr.progressBarStyleHorizontal);progress.setMax(100);progress.setPadding(0,dp(9),0,0);box.addView(progress,new LinearLayout.LayoutParams(-1,dp(18)));
        progressText=text("",12,Color.rgb(147,204,255));box.addView(progressText);
        primary=new Button(activity);primary.setTextColor(Color.WHITE);primary.setAllCaps(false);primary.setTextSize(15);GradientDrawable button=new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,new int[]{Color.rgb(133,62,255),Color.rgb(38,112,245),Color.rgb(0,198,235)});button.setCornerRadius(dp(15));primary.setBackground(button);LinearLayout.LayoutParams bp=new LinearLayout.LayoutParams(-1,dp(52));bp.topMargin=dp(16);box.addView(primary,bp);
        secondary=new Button(activity);secondary.setTextColor(Color.rgb(191,201,235));secondary.setAllCaps(false);secondary.setBackgroundColor(Color.TRANSPARENT);box.addView(secondary,new LinearLayout.LayoutParams(-1,dp(46)));
        dialog=new AlertDialog.Builder(activity).setView(box).create();dialog.setOnKeyListener((d,key,event)->coordinator.current().metadata!=null&&coordinator.current().metadata.mandatory&&key==android.view.KeyEvent.KEYCODE_BACK);
    }

    private void primary(AppUpdateCoordinator.Snapshot s){
        switch(s.state){case AVAILABLE:case FAILED:coordinator.download();break;case READY_TO_INSTALL:if(!coordinator.canInstallPackages()){coordinator.requireInstallPermission();activity.startActivity(coordinator.installPermissionIntent());}else openInstaller();break;case INSTALL_PERMISSION_REQUIRED:activity.startActivity(coordinator.installPermissionIntent());break;default:coordinator.check(true);}
    }
    private void openInstaller(){Intent i=coordinator.installerIntent();if(i==null){return;}try{activity.startActivity(i);}catch(Exception e){android.widget.Toast.makeText(activity,"Android installer is unavailable.",android.widget.Toast.LENGTH_LONG).show();}}
    private String action(AppUpdateCoordinator.State s){switch(s){case AVAILABLE:return"Update Now";case READY_TO_INSTALL:return"Install Update";case INSTALL_PERMISSION_REQUIRED:return"Allow Installation";case FAILED:return"Retry";case CHECKING:return"Checking…";default:return"Downloading…";}}
    private String label(AppUpdateCoordinator.State s){return s.name().toLowerCase(Locale.US).replace('_',' ');}
    private TextView text(String value,int size,int color){TextView v=new TextView(activity);v.setText(value);v.setTextSize(size);v.setTextColor(color);return v;}
    private int dp(int v){return Math.round(v*activity.getResources().getDisplayMetrics().density);}
    private static String formatSize(long b){return b<=0?"Size unknown":String.format(Locale.US,"%.1f MB",b/1048576.0);}
}
